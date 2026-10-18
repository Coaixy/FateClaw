import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  IssueCreateDto,
  IssueKind,
  IssueLabel,
  IssueModerationDto,
  IssueState,
  IssueEntryType,
  IssueCloseReason,
} from '@fateclaw/contracts';
import { getDbPool } from '#infrastructure/db-pool';
import { queryOne, queryRows } from '#infrastructure/typed-query';
import { IssueError } from '#modules/issues/issue-errors';

export type IssueActor =
  | { kind: 'user'; userId: string }
  | { kind: 'official' };
export interface IssueRow {
  id: number;
  author_user_id: string;
  title: string;
  body: string;
  kind: IssueKind;
  state: IssueState;
  close_reason: IssueCloseReason | null;
  labels: IssueLabel[];
  locked: boolean;
  hidden: boolean;
  created_at: Date;
  updated_at: Date;
  comment_count?: number;
  request_hash: string;
}
export interface IssueEntryRow {
  id: number;
  issue_id: number;
  actor_kind: 'user' | 'official';
  actor_user_id: string | null;
  participant_number: number | null;
  type: IssueEntryType;
  body: string | null;
  close_reason: IssueCloseReason | null;
  hidden: boolean;
  created_at: Date;
  updated_at: Date;
  request_hash: string | null;
}
export interface IssueListFilter {
  q?: string;
  state?: IssueState;
  kind?: IssueKind;
  label?: IssueLabel;
  mine?: string;
  page: number;
  page_size: number;
}

async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'",
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function lockUser(client: PoolClient, userId: string) {
  // Serializes quotas, edits and moderation across every API instance.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `issues:user:${userId}`,
  ]);
}

async function requireUnmuted(client: PoolClient, userId: string) {
  const row = await queryOne<{ muted: boolean }>(
    client,
    'SELECT muted FROM issue_user_moderation WHERE user_id=$1',
    [userId],
  );
  if (row?.muted) throw new IssueError(403, '此账号已被暂停发布问题与评论');
}

async function quota(
  client: PoolClient,
  userId: string,
  kind: 'issue' | 'comment',
) {
  const row =
    kind === 'issue'
      ? await queryOne<{ count: string; elapsed: string | null }>(
          client,
          "SELECT count(*) AS count,EXTRACT(EPOCH FROM clock_timestamp()-max(created_at)) AS elapsed FROM issues WHERE author_user_id=$1 AND created_at>clock_timestamp()-interval '24 hours'",
          [userId],
        )
      : await queryOne<{ count: string; elapsed: string | null }>(
          client,
          "SELECT count(*) AS count,EXTRACT(EPOCH FROM clock_timestamp()-max(created_at)) AS elapsed FROM issue_entries WHERE actor_user_id=$1 AND type='comment' AND created_at>clock_timestamp()-interval '24 hours'",
          [userId],
        );
  const interval = kind === 'issue' ? 60 : 10;
  if (Number(row?.count ?? 0) >= (kind === 'issue' ? 5 : 50))
    throw new IssueError(429, '已达到过去 24 小时的发布上限', 3600);
  const elapsed =
    row?.elapsed === null || row?.elapsed === undefined
      ? Infinity
      : Number(row.elapsed);
  if (elapsed < interval)
    throw new IssueError(
      429,
      '发布过于频繁，请稍后再试',
      Math.max(1, Math.ceil(interval - elapsed)),
    );
}

async function lockedIssue(client: PoolClient, id: number, admin = false) {
  const row = await queryOne<IssueRow>(
    client,
    'SELECT * FROM issues WHERE id=$1 FOR UPDATE',
    [id],
  );
  if (!row || (row.hidden && !admin))
    throw new IssueError(404, '问题不存在或已隐藏');
  return row;
}

async function addEntry(
  client: PoolClient,
  issueId: number,
  actor: IssueActor,
  type: IssueEntryType,
  reason: IssueCloseReason | null = null,
) {
  await client.query(
    'INSERT INTO issue_entries(issue_id,actor_kind,actor_user_id,type,close_reason) VALUES($1,$2,$3,$4,$5)',
    [
      issueId,
      actor.kind,
      actor.kind === 'user' ? actor.userId : null,
      type,
      reason,
    ],
  );
}

export async function listIssueRows(filter: IssueListFilter, admin: boolean) {
  return transaction(async (client) => {
    const q = filter.q ? `%${filter.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const params = [
      admin,
      q,
      filter.state ?? null,
      filter.kind ?? null,
      filter.label ?? null,
      filter.mine ?? null,
    ];
    const where = `WHERE ($1 OR NOT i.hidden) AND ($2::text IS NULL OR i.title ILIKE $2)
    AND ($3::text IS NULL OR i.state=$3) AND ($4::text IS NULL OR i.kind=$4)
    AND ($5::text IS NULL OR $5=ANY(i.labels)) AND ($6::text IS NULL OR i.author_user_id=$6)`;
    const rows = await queryRows<IssueRow>(
      client,
      `SELECT i.*,
    (SELECT count(*)::int FROM issue_entries e WHERE e.issue_id=i.id AND e.type='comment' AND ($1 OR NOT e.hidden)) AS comment_count
    FROM issues i ${where} ORDER BY i.updated_at DESC,i.id DESC LIMIT $7 OFFSET $8`,
      [...params, filter.page_size, (filter.page - 1) * filter.page_size],
    );
    const total = await queryOne<{ count: string }>(
      client,
      `SELECT count(*) AS count FROM issues i ${where}`,
      params,
    );
    return { rows, total: Number(total?.count ?? 0) };
  });
}

export async function getIssueRows(id: number, after: number, admin: boolean) {
  // The visibility check and timeline share a snapshot, so a concurrent hide cannot leak a partial result.
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const issue = await queryOne<IssueRow>(
      client,
      `SELECT i.*,
      (SELECT count(*)::int FROM issue_entries e WHERE e.issue_id=i.id AND e.type='comment' AND ($2 OR NOT e.hidden)) AS comment_count
      FROM issues i WHERE i.id=$1 AND ($2 OR NOT i.hidden)`,
      [id, admin],
    );
    if (!issue) throw new IssueError(404, '问题不存在或已隐藏');
    const entries = await queryRows<IssueEntryRow>(
      client,
      `SELECT e.*,p.participant_number FROM issue_entries e
      LEFT JOIN issue_participants p ON p.issue_id=e.issue_id AND p.user_id=e.actor_user_id
      WHERE e.issue_id=$1 AND ($2=0 OR e.id<$2) AND ($3 OR NOT e.hidden) ORDER BY e.id DESC LIMIT 51`,
      [id, after, admin],
    );
    const identities = admin
      ? await queryRows<{
          participant_number: number;
          user_id: string;
          phone: string | null;
          phone_verified: boolean;
          created_at: Date;
          muted: boolean;
        }>(
          client,
          `SELECT p.participant_number,u.id AS user_id,u.phone,u.phone_verified,u.created_at,COALESCE(m.muted,false) AS muted
       FROM issue_participants p JOIN users u ON u.id=p.user_id LEFT JOIN issue_user_moderation m ON m.user_id=u.id
       WHERE p.issue_id=$1 AND (p.participant_number=0 OR u.id=ANY($2::text[])) ORDER BY p.participant_number`,
          [
            id,
            entries
              .slice(0, 50)
              .flatMap((entry) =>
                entry.actor_user_id ? [entry.actor_user_id] : [],
              ),
          ],
        )
      : [];
    return {
      issue,
      entries: entries.slice(0, 50).reverse(),
      next_cursor: entries.length > 50 ? entries[49].id : null,
      identities,
    };
  });
}

export async function insertIssue(userId: string, input: IssueCreateDto) {
  const hash = fingerprint([input.title, input.body, input.kind]);
  return transaction(async (client) => {
    await lockUser(client, userId);
    const previous = await queryOne<{ id: number; request_hash: string }>(
      client,
      'SELECT id,request_hash FROM issues WHERE author_user_id=$1 AND request_key=$2',
      [userId, input.request_key],
    );
    if (previous) {
      if (previous.request_hash !== hash)
        throw new IssueError(409, '同一请求标识不能用于不同内容');
      return { id: previous.id };
    }
    await requireUnmuted(client, userId);
    await quota(client, userId, 'issue');
    const duplicate = await queryOne(
      client,
      "SELECT id FROM issues WHERE author_user_id=$1 AND request_hash=$2 AND created_at>clock_timestamp()-interval '10 minutes'",
      [userId, hash],
    );
    if (duplicate) throw new IssueError(409, '请勿重复提交相同的问题');
    const row = await queryOne<{ id: number }>(
      client,
      'INSERT INTO issues(author_user_id,title,body,kind,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [userId, input.title, input.body, input.kind, input.request_key, hash],
    );
    await client.query(
      'INSERT INTO issue_participants(issue_id,user_id,participant_number) VALUES($1,$2,0)',
      [row!.id, userId],
    );
    return { id: row!.id };
  });
}

export async function insertIssueComment(
  id: number,
  actor: IssueActor,
  body: string,
  requestKey: string,
) {
  const hash = fingerprint([id, body]);
  return transaction(async (client) => {
    // Official replies share an idempotency namespace; user replies serialize with account quotas.
    await lockUser(client, actor.kind === 'user' ? actor.userId : 'official');
    const previous =
      actor.kind === 'user'
        ? await queryOne<{ id: number; request_hash: string }>(
            client,
            'SELECT id,request_hash FROM issue_entries WHERE actor_user_id=$1 AND request_key=$2',
            [actor.userId, requestKey],
          )
        : await queryOne<{ id: number; request_hash: string }>(
            client,
            "SELECT id,request_hash FROM issue_entries WHERE actor_kind='official' AND request_key=$1",
            [requestKey],
          );
    if (previous) {
      if (previous.request_hash !== hash)
        throw new IssueError(409, '同一请求标识不能用于不同内容');
      return { id: previous.id };
    }
    const issue = await lockedIssue(client, id, actor.kind === 'official');
    if (actor.kind === 'user') {
      await requireUnmuted(client, actor.userId);
      if (issue.locked) throw new IssueError(403, '此讨论已锁定');
      await quota(client, actor.userId, 'comment');
      const duplicate = await queryOne(
        client,
        "SELECT id FROM issue_entries WHERE issue_id=$1 AND actor_user_id=$2 AND request_hash=$3 AND created_at>clock_timestamp()-interval '10 minutes'",
        [id, actor.userId, hash],
      );
      if (duplicate) throw new IssueError(409, '请勿重复发送相同评论');
      await client.query(
        `INSERT INTO issue_participants(issue_id,user_id,participant_number)
        SELECT $1,$2,COALESCE(max(participant_number),0)+1 FROM issue_participants WHERE issue_id=$1
        ON CONFLICT(issue_id,user_id) DO NOTHING`,
        [id, actor.userId],
      );
    }
    const entry = await queryOne<{ id: number }>(
      client,
      "INSERT INTO issue_entries(issue_id,actor_kind,actor_user_id,type,body,request_key,request_hash) VALUES($1,$2,$3,'comment',$4,$5,$6) RETURNING id",
      [
        id,
        actor.kind,
        actor.kind === 'user' ? actor.userId : null,
        body,
        requestKey,
        hash,
      ],
    );
    await client.query(
      'UPDATE issues SET updated_at=clock_timestamp() WHERE id=$1',
      [id],
    );
    return { id: entry!.id };
  });
}

export async function editIssue(
  id: number,
  userId: string,
  title: string,
  body: string,
) {
  return transaction(async (client) => {
    await lockUser(client, userId);
    await requireUnmuted(client, userId);
    const issue = await lockedIssue(client, id);
    if (issue.author_user_id !== userId || issue.locked)
      throw new IssueError(403, '无权编辑此问题');
    if (issue.title === title && issue.body === body) return;
    await client.query(
      'UPDATE issues SET title=$2,body=$3,updated_at=clock_timestamp() WHERE id=$1',
      [id, title, body],
    );
    await addEntry(client, id, { kind: 'user', userId }, 'edited');
  });
}

export async function editIssueComment(
  id: number,
  entryId: number,
  userId: string,
  body: string,
) {
  return transaction(async (client) => {
    await lockUser(client, userId);
    await requireUnmuted(client, userId);
    const issue = await lockedIssue(client, id);
    const entry = await queryOne<IssueEntryRow>(
      client,
      "SELECT * FROM issue_entries WHERE id=$1 AND issue_id=$2 AND type='comment' AND NOT hidden FOR UPDATE",
      [entryId, id],
    );
    if (!entry) throw new IssueError(404, '评论不存在');
    if (entry.actor_user_id !== userId || issue.locked)
      throw new IssueError(403, '无权编辑此评论');
    if (entry.body === body) return;
    await client.query(
      'UPDATE issue_entries SET body=$2,updated_at=clock_timestamp() WHERE id=$1',
      [entryId, body],
    );
  });
}

export async function moderateIssue(id: number, input: IssueModerationDto) {
  return transaction(async (client) => {
    const row = await lockedIssue(client, id, true);
    const state = input.state ?? row.state;
    if (state === 'open' && input.close_reason)
      throw new IssueError(400, '未关闭的问题不能设置关闭原因');
    const reason =
      state === 'open'
        ? null
        : input.close_reason === undefined
          ? row.close_reason
          : input.close_reason;
    if (state === 'closed' && !reason)
      throw new IssueError(400, '关闭问题时请选择原因');
    const labels = input.labels ?? row.labels;
    const locked = input.locked ?? row.locked;
    const hidden = input.hidden ?? row.hidden;
    if (
      state === row.state &&
      reason === row.close_reason &&
      locked === row.locked &&
      hidden === row.hidden &&
      JSON.stringify(labels) === JSON.stringify(row.labels)
    )
      return;
    await client.query(
      'UPDATE issues SET state=$2,close_reason=$3,labels=$4,locked=$5,hidden=$6,updated_at=clock_timestamp() WHERE id=$1',
      [id, state, reason, labels, locked, hidden],
    );
    const actor: IssueActor = { kind: 'official' };
    if (state !== row.state || reason !== row.close_reason)
      await addEntry(
        client,
        id,
        actor,
        state === 'open' ? 'reopened' : 'closed',
        reason,
      );
    if (locked !== row.locked)
      await addEntry(client, id, actor, locked ? 'locked' : 'unlocked');
    if (JSON.stringify(labels) !== JSON.stringify(row.labels))
      await addEntry(client, id, actor, 'labels_changed');
  });
}

export async function moderateIssueComment(
  id: number,
  entryId: number,
  hidden: boolean,
) {
  return transaction(async (client) => {
    await lockedIssue(client, id, true);
    const row = await queryOne(
      client,
      "UPDATE issue_entries SET hidden=$3 WHERE issue_id=$1 AND id=$2 AND type='comment' RETURNING id",
      [id, entryId, hidden],
    );
    if (!row) throw new IssueError(404, '评论不存在');
  });
}

export async function moderateIssueParticipant(
  id: number,
  participant: number,
  muted: boolean,
) {
  return transaction(async (client) => {
    const row = await queryOne<{ user_id: string }>(
      client,
      'SELECT user_id FROM issue_participants WHERE issue_id=$1 AND participant_number=$2',
      [id, participant],
    );
    if (!row) throw new IssueError(404, '参与者不存在');
    await lockUser(client, row.user_id);
    await client.query(
      `INSERT INTO issue_user_moderation(user_id,muted) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET muted=EXCLUDED.muted,updated_at=clock_timestamp()`,
      [row.user_id, muted],
    );
  });
}
