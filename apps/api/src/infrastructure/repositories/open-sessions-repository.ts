import { randomBytes, randomUUID } from 'node:crypto';

import { getDbPool } from '../db-pool.js';

/** 对外开放会话的 public sid 前缀（与 fc_live_ 风格一致，便于辨识）。 */
export const OPEN_SESSION_ID_PREFIX = 'sess_';

/** 会话滑动 TTL（天）：建会话与每轮活动都把 expires_at 顺延这么多天。 */
export const OPEN_SESSION_TTL_DAYS = 30;

/** 建会话时存入的盘面快照（来自调用方 fateclaw.board，原样留存）。 */
export interface OpenSessionBoardSnapshot {
  /** 排盘类型短名（如 bazi）；缺省按通用盘面处理。 */
  type?: string;
  /** AI 可读盘面文本（来自 /api/v1/paipan/:type 的 text）。 */
  text?: string;
  /** 结构化盘面数据（来自 paipan 的 data）。 */
  data?: unknown;
}

/**
 * open_sessions 表行（含敏感字段 user_id / runtime_session_id / persona_prompt，
 * **不可直接对外返回**）。
 *
 * @remarks pg 对 TIMESTAMPTZ 返回 Date、对 JSONB 返回已解析的 JS 值；转 DTO 时序列化时间为 ISO。
 */
export interface OpenSessionRow {
  id: string;
  user_id: string;
  api_key_id: string | null;
  runtime_session_id: string;
  model_key: string;
  thinking_level: string | null;
  persona_prompt: string | null;
  authorized_skill_ids: string[] | null;
  board: OpenSessionBoardSnapshot | null;
  status: 'active' | 'deleted';
  created_at: Date;
  last_active_at: Date;
  expires_at: Date | null;
}

/** 会话对外脱敏视图：剔除 runtime_session_id / user_id / persona / board 等内部字段。 */
export interface OpenSessionDto {
  id: string;
  object: 'session';
  /** 会话固定使用的官方模型 model_key。 */
  model: string;
  status: 'active' | 'deleted';
  /** 创建时间（ISO 8601）。 */
  created_at: string;
  /** 最近一次发消息时间（ISO 8601）。 */
  last_active_at: string;
  /** 过期时间（ISO 8601）；活动会顺延。null 表示不过期（当前不会出现）。 */
  expires_at: string | null;
}

/** 生成一个不可猜的 public sid。 */
function generateOpenSessionId(): string {
  // 24 字节随机熵 → base64url（URL 安全、无填充），拼上前缀。
  return `${OPEN_SESSION_ID_PREFIX}${randomBytes(24).toString('base64url')}`;
}

/**
 * 把表行转为对外脱敏 DTO。
 *
 * @param row 数据库行。
 * @returns 仅含可公开字段的 {@link OpenSessionDto}。
 */
export function toOpenSessionDto(row: OpenSessionRow): OpenSessionDto {
  return {
    id: row.id,
    object: 'session',
    model: row.model_key,
    status: row.status,
    created_at: row.created_at.toISOString(),
    last_active_at: row.last_active_at.toISOString(),
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

/**
 * 创建一个对外开放会话。
 *
 * @param input 归属用户、来源 key、官方 model_key、思考等级、persona(system) 快照、
 *   授权 skill id 快照、盘面快照。
 * @returns 新建行（含 public id 与内部 runtime_session_id）。
 * @remarks public id（sess_…）对外返回；runtime_session_id（openapi:<uuid>）仅服务端内部用，
 *   绝不外泄。expires_at 设为 NOW() + TTL。
 */
export async function createOpenSession(input: {
  userId: string;
  apiKeyId: string | null;
  modelKey: string;
  thinkingLevel?: string | null;
  persona?: string | null;
  skillIds?: string[] | null;
  board?: OpenSessionBoardSnapshot | null;
}): Promise<OpenSessionRow> {
  const id = generateOpenSessionId();
  const runtimeSessionId = `openapi:${randomUUID()}`;
  const { rows } = await getDbPool().query<OpenSessionRow>(
    `INSERT INTO open_sessions
       (id, user_id, api_key_id, runtime_session_id, model_key, thinking_level,
        persona_prompt, authorized_skill_ids, board, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
             NOW() + ($10 || ' days')::interval)
     RETURNING *`,
    [
      id,
      input.userId,
      input.apiKeyId,
      runtimeSessionId,
      input.modelKey,
      input.thinkingLevel ?? null,
      input.persona ?? null,
      input.skillIds ? JSON.stringify(input.skillIds) : null,
      input.board ? JSON.stringify(input.board) : null,
      String(OPEN_SESSION_TTL_DAYS),
    ],
  );
  return rows[0]!;
}

/**
 * 按 sid + 归属用户查找「有效」会话（发消息 / 查询前置校验）。
 *
 * @returns 命中且 status='active' 且未过期的行；否则 null（不存在 / 不归属 / 已删 / 已过期）。
 * @remarks 同时按 user_id 过滤是防跨用户 resume 的关键。
 */
export async function findOpenSessionByIdForUser(
  id: string,
  userId: string,
): Promise<OpenSessionRow | null> {
  const { rows } = await getDbPool().query<OpenSessionRow>(
    `SELECT * FROM open_sessions
      WHERE id = $1 AND user_id = $2 AND status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/**
 * 刷新会话活动时间并顺延 TTL（每轮发消息成功后调用）。
 *
 * @remarks 与 find/softDelete 一致地自带 user_id + status='active' 约束，落实「所有读写都带
 *   user_id 过滤」不变量——既防误用成无归属写入面，也避免给已软删会话续期 TTL。
 */
export async function touchOpenSessionActivity(
  id: string,
  userId: string,
): Promise<void> {
  await getDbPool().query(
    `UPDATE open_sessions
        SET last_active_at = NOW(),
            expires_at = NOW() + ($3 || ' days')::interval
      WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [id, userId, String(OPEN_SESSION_TTL_DAYS)],
  );
}

/**
 * 软删某用户名下的一个会话。
 *
 * @returns 是否实际删除了一行；false 表示不存在 / 不归属 / 已删。
 */
export async function softDeleteOpenSession(input: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const { rowCount } = await getDbPool().query(
    `UPDATE open_sessions
        SET status = 'deleted'
      WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [input.id, input.userId],
  );
  return (rowCount ?? 0) > 0;
}
