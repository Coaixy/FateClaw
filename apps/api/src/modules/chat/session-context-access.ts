import type { PoolClient } from 'pg';
import type { MemoryRequestScope } from '@fateclaw/contracts/memory';
import { MemoryError } from '#modules/memory/domain';
import {
  assertMemoryBindingCurrent,
  hasOwnerMemoryAudience,
  withMemoryTransaction,
} from '#modules/memory/repository';

interface SessionMessageIdentity {
  id: string;
  account_id?: string;
  session_id?: string | null;
  user_id?: string | null;
}

interface ContextMessageProvenance {
  id: string;
  request_snapshot: unknown;
  source_snapshot: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasSnapshot(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const snapshot = record(value);
  return !snapshot || Object.keys(snapshot).length > 0;
}

function matchesActor(value: unknown, scope: MemoryRequestScope): boolean {
  const snapshot = record(value);
  return Boolean(
    snapshot &&
    snapshot.ownerUserId === scope.ownerUserId &&
    snapshot.actorKey === scope.actorKey &&
    snapshot.audienceKey === scope.audienceKey &&
    typeof snapshot.contextAudience === 'string' &&
    snapshot.contextAudience === (scope.contextAudience ?? '') &&
    (snapshot.bindingRevision ?? 1) === (scope.bindingRevision ?? 1),
  );
}

/** Filter persisted resources by immutable attribution; never infer identity from text or names. */
export async function filterSessionContextMessages<
  T extends SessionMessageIdentity,
>(args: {
  scope: MemoryRequestScope;
  accountId: string;
  sessionId: string;
  messages: readonly T[];
  selectedBoardMessageId?: string;
  db?: PoolClient;
}): Promise<T[]> {
  // Board visibility follows actor attribution, not memory settings or the discussed subject.
  const filter = async (db: PoolClient): Promise<T[]> => {
    await assertMemoryBindingCurrent(args.scope, db);
    const candidates = args.messages.filter(
      (message) =>
        (message.account_id === undefined ||
          message.account_id === args.accountId) &&
        (message.session_id === undefined ||
          message.session_id === args.sessionId) &&
        (message.user_id === undefined ||
          message.user_id === null ||
          message.user_id === args.scope.ownerUserId),
    );
    const ids = [...new Set(candidates.map((message) => message.id))];
    let allowed = new Set<string>();
    if (ids.length) {
      const { rows } = await db.query<ContextMessageProvenance>(
        `SELECT m.id,r.memory_scope AS request_snapshot,src.identity_snapshot AS source_snapshot
         FROM messages m JOIN chat_sessions c ON c.id=m.session_id AND c.account_id=m.account_id
         LEFT JOIN agent_requests r ON r.request_id=m.metadata->>'request_id'
           AND r.session_id=c.id AND r.account_id=c.account_id AND r.owner_user_id=c.user_id
         LEFT JOIN LATERAL (
           SELECT s.identity_snapshot FROM memory_sources s
           WHERE s.message_id=m.id AND s.account_id=m.account_id AND s.session_id=c.id
             AND s.owner_user_id=c.user_id AND s.source_kind='message'
           ORDER BY s.revision DESC,s.source_sequence DESC LIMIT 1
         ) src ON true
         WHERE m.id=ANY($1::text[]) AND m.account_id=$2 AND m.session_id=$3 AND c.user_id=$4
           AND (m.user_id IS NULL OR m.user_id=$4) AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
        [ids, args.accountId, args.sessionId, args.scope.ownerUserId],
      );
      const owner = hasOwnerMemoryAudience(args.scope);
      allowed = new Set(
        rows
          .filter((row) => {
            if (owner) return true;
            const snapshots = [
              row.source_snapshot,
              row.request_snapshot,
            ].filter(hasSnapshot);
            // A conflicting or partial frozen identity must not fall back to a weaker proof.
            return (
              snapshots.length > 0 &&
              snapshots.every((snapshot) => matchesActor(snapshot, args.scope))
            );
          })
          .map((row) => row.id),
      );
    }
    if (
      args.selectedBoardMessageId &&
      !allowed.has(args.selectedBoardMessageId)
    )
      throw new MemoryError(
        '当前请求无权使用指定盘面，请重新选择或提供盘面',
        403,
        'MEMORY.BOARD_DENIED',
      );
    return candidates.filter((message) => allowed.has(message.id));
  };
  return args.db ? filter(args.db) : withMemoryTransaction(filter);
}
