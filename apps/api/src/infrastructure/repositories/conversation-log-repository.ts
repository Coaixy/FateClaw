import type pg from 'pg';
import { getDbPool } from '../db-pool.js';
import { isPiSessionFrame } from '@fateclaw/contracts/agent/session';
import {
  getPiSessionSnapshot,
  storePiSessionFrame,
} from './pi-session-frames-repository.js';

export interface ConversationLogRow {
  id: string;
  account_id: string;
  request_id: string;
  transcript: unknown[];
  usage: unknown;
  model: string | null;
  provider: string | null;
  trace_events: unknown[] | null;
  agent_graph: unknown | null;
  agent_graph_summary: unknown | null;
  capability_ledger: unknown | null;
  created_at: string;
}

/**
 * 列表场景下的轻量行，不含 transcript / trace_events 正文，
 * 只保留元数据 + 计数字段。
 *
 * 动机：单行完整 JSONB 可能 20-200KB，20 行列表响应会达到 MB 级别，
 * 拖慢首屏和分页。列表只需要扫读信息，详情用 getConversationLogById /
 * getConversationLogByRequestId 按需拉完整数据。
 */
export interface ConversationLogSummaryRow {
  id: string;
  account_id: string;
  request_id: string;
  usage: unknown;
  model: string | null;
  provider: string | null;
  agent_graph_summary: unknown | null;
  created_at: string;
  tool_call_count: number;
  transcript_event_count: number;
  trace_event_count: number;
}

function buildTraceEventsForStorage(log: {
  requestId: string;
  traceEvents?: unknown[];
  piSession?: unknown;
}): unknown[] {
  if (!log.piSession) {
    return log.traceEvents ?? [];
  }

  return [
    ...(log.traceEvents ?? []),
    ...(isPiSessionFrame(log.piSession)
      ? [{ type: 'pi_session_frame', requestId: log.requestId }]
      : [
          {
            type: 'pi_session_snapshot',
            timestamp: new Date().toISOString(),
            session: log.piSession,
          },
        ]),
  ];
}

function countToolUseEvents(transcript: unknown[]): number {
  return transcript.reduce<number>((count, event) => {
    if (
      event &&
      typeof event === 'object' &&
      'type' in event &&
      (event as { type?: unknown }).type === 'tool_use'
    ) {
      return count + 1;
    }
    return count;
  }, 0);
}

export async function storeConversationLog(
  log: {
    id: string;
    accountId: string;
    requestId: string;
    sessionId?: string;
    transcript: unknown[];
    usage?: unknown;
    model?: string | null;
    provider?: string | null;
    traceEvents?: unknown[];
    piSession?: unknown;
    agentGraph?: unknown;
  },
  transaction?: pg.PoolClient,
): Promise<void> {
  const usesPiSession = Boolean(log.piSession);
  const agentGraph = usesPiSession ? undefined : log.agentGraph;
  const graphSummary =
    agentGraph &&
    typeof agentGraph === 'object' &&
    'summary' in (agentGraph as Record<string, unknown>)
      ? (agentGraph as Record<string, unknown>).summary
      : null;
  const transcript = usesPiSession ? [] : (log.transcript ?? []);
  const traceEvents = buildTraceEventsForStorage(log);
  const client = transaction ?? (await getDbPool().connect());
  try {
    if (!transaction) await client.query('BEGIN');
    if (isPiSessionFrame(log.piSession)) {
      if (!log.sessionId)
        throw new Error('Pi session frame is missing its session owner');
      await storePiSessionFrame(
        client,
        log.requestId,
        log.sessionId,
        log.accountId,
        log.piSession,
      );
    }
    await client.query(
      `INSERT INTO conversation_logs (
         id, account_id, request_id, usage, model, provider,
         transcript_event_count, tool_call_count, trace_event_count,
         agent_graph_summary, capability_ledger, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        log.id,
        log.accountId,
        log.requestId,
        log.usage ? JSON.stringify(log.usage) : null,
        log.model ?? null,
        log.provider ?? null,
        log.transcript.length,
        countToolUseEvents(log.transcript),
        traceEvents.length,
        graphSummary ? JSON.stringify(graphSummary) : null,
        null,
      ],
    );
    await client.query(
      `INSERT INTO conversation_log_payloads (log_id, transcript, trace_events, agent_graph)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (log_id) DO NOTHING`,
      [
        log.id,
        JSON.stringify(transcript),
        traceEvents.length > 0 ? JSON.stringify(traceEvents) : null,
        agentGraph ? JSON.stringify(agentGraph) : null,
      ],
    );
    if (!transaction) await client.query('COMMIT');
  } catch (err) {
    if (!transaction) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!transaction) client.release();
  }
}

/**
 * 列表场景下的轻量查询。仅用于 admin 面板 /api/admin/logs。
 */
export async function getConversationLogSummaries(
  accountId: string,
  limit: number = 20,
  before?: string,
): Promise<ConversationLogSummaryRow[]> {
  const conditions = ['account_id = $1'];
  const params: unknown[] = [accountId, limit];

  if (before) {
    params.push(before);
    conditions.push(`created_at < $${params.length}`);
  }

  const { rows } = await getDbPool().query(
    `SELECT
       id, account_id, request_id, usage, model, provider, agent_graph_summary, created_at,
       tool_call_count, transcript_event_count, trace_event_count
     FROM conversation_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $2`,
    params,
  );
  return rows as ConversationLogSummaryRow[];
}

/**
 * 清空多个运行账号下的对话日志，用于 admin 按用户批量清理。
 */
export async function deleteConversationLogsByAccountIds(
  accountIds: string[],
): Promise<number> {
  if (accountIds.length === 0) return 0;
  const result = await getDbPool().query(
    'DELETE FROM conversation_logs WHERE account_id = ANY($1::text[])',
    [accountIds],
  );
  return result.rowCount ?? 0;
}

export async function getConversationLogById(
  id: string,
): Promise<ConversationLogRow | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT
       l.id,
       l.account_id,
       l.request_id,
       COALESCE(p.transcript, '[]'::jsonb) AS transcript,
       l.usage,
       l.model,
       l.provider,
       p.trace_events,
       p.agent_graph,
       l.agent_graph_summary,
       l.capability_ledger,
       l.created_at
     FROM conversation_logs l
     LEFT JOIN conversation_log_payloads p ON p.log_id = l.id
     WHERE l.id = $1`,
    [id],
  );
  return hydratePiSession(rows[0] as ConversationLogRow | undefined);
}

/**
 * 按 request_id 查单条 log，admin 排障场景使用。
 * 依赖 idx_conversation_logs_request_id B-tree 索引。
 */
export async function getConversationLogByRequestId(
  requestId: string,
): Promise<ConversationLogRow | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT
       l.id,
       l.account_id,
       l.request_id,
       COALESCE(p.transcript, '[]'::jsonb) AS transcript,
       l.usage,
       l.model,
       l.provider,
       p.trace_events,
       p.agent_graph,
       l.agent_graph_summary,
       l.capability_ledger,
       l.created_at
     FROM conversation_logs l
     LEFT JOIN conversation_log_payloads p ON p.log_id = l.id
     WHERE l.request_id = $1
     ORDER BY l.created_at DESC
     LIMIT 1`,
    [requestId],
  );
  return hydratePiSession(rows[0] as ConversationLogRow | undefined);
}

async function hydratePiSession(
  row: ConversationLogRow | undefined,
): Promise<ConversationLogRow | undefined> {
  if (
    !row?.trace_events?.some(
      (event) =>
        event &&
        typeof event === 'object' &&
        (event as { type?: string }).type === 'pi_session_frame',
    )
  )
    return row;
  const snapshot = await getPiSessionSnapshot(row.request_id, row.account_id);
  if (!snapshot) throw new Error('Missing persisted Pi session frame');
  return {
    ...row,
    trace_events: row.trace_events.map((event) =>
      event &&
      typeof event === 'object' &&
      (event as { type?: string }).type === 'pi_session_frame'
        ? { type: 'pi_session_snapshot', session: snapshot }
        : event,
    ),
  };
}

/**
 * 清理过期 trace_events：把 N 天前的 trace_events 列置 NULL。
 * transcript / usage / agent_graph_summary 等业务数据保留不变。
 *
 * trace 是纯调试数据，保留短期用于排障，过期后释放存储空间。
 * 返回被清理的行数。
 */
export async function purgeExpiredTraceEvents(
  retentionDays: number,
): Promise<number> {
  // 分批 UPDATE 防止生产大数据量时长事务锁表 + WAL 膨胀
  const BATCH_SIZE = 1000;
  let totalCleared = 0;
  while (true) {
    const result = await getDbPool().query(
      `WITH target AS (
         SELECT p.log_id
         FROM conversation_log_payloads p
         JOIN conversation_logs l ON l.id = p.log_id
         WHERE p.trace_events IS NOT NULL
           AND l.created_at < NOW() - (INTERVAL '1 day' * $1)
         LIMIT $2
       ),
       cleared AS (
         UPDATE conversation_log_payloads p
         SET trace_events = NULL
         FROM target t
         WHERE p.log_id = t.log_id
         RETURNING p.log_id
       )
       UPDATE conversation_logs l
       SET trace_event_count = 0
       WHERE l.id IN (SELECT log_id FROM cleared)`,
      [retentionDays, BATCH_SIZE],
    );
    const batch = result.rowCount ?? 0;
    totalCleared += batch;
    if (batch < BATCH_SIZE) break;
  }
  return totalCleared;
}
