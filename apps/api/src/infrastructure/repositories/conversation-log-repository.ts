import { getDbPool } from '../db-pool.js';

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

export async function storeConversationLog(log: {
  id: string;
  accountId: string;
  requestId: string;
  transcript: unknown[];
  usage?: unknown;
  model?: string | null;
  provider?: string | null;
  traceEvents?: unknown[];
  agentGraph?: unknown;
}): Promise<void> {
  const graphSummary =
    log.agentGraph &&
    typeof log.agentGraph === 'object' &&
    'summary' in (log.agentGraph as Record<string, unknown>)
      ? (log.agentGraph as Record<string, unknown>).summary
      : null;
  const transcript = log.transcript ?? [];
  const traceEvents = log.traceEvents ?? [];
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
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
        transcript.length,
        countToolUseEvents(transcript),
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
        log.agentGraph ? JSON.stringify(log.agentGraph) : null,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getConversationLogs(
  accountId: string,
  limit: number = 20,
  before?: string,
): Promise<ConversationLogRow[]> {
  const conditions = ['l.account_id = $1'];
  const params: unknown[] = [accountId, limit];

  if (before) {
    params.push(before);
    conditions.push(`l.created_at < $${params.length}`);
  }

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
     WHERE ${conditions.join(' AND ')}
     ORDER BY l.created_at DESC LIMIT $2`,
    params,
  );
  return rows as ConversationLogRow[];
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
  return rows[0] as ConversationLogRow | undefined;
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
  return rows[0] as ConversationLogRow | undefined;
}

export async function getConversationLogsByTimeWindow(
  accountId: string,
  around: string,
  windowSeconds: number = 60,
): Promise<ConversationLogRow[]> {
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
     WHERE l.account_id = $1
       AND l.created_at BETWEEN ($2::timestamptz - interval '1 second' * $3)
                         AND ($2::timestamptz + interval '10 seconds')
     ORDER BY l.created_at DESC
     LIMIT 5`,
    [accountId, around, windowSeconds],
  );
  return rows as ConversationLogRow[];
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
  // eslint-disable-next-line no-constant-condition
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
