/**
 * 客户（被算者）档案服务层。
 *
 * 负责客户档案的 CRUD、归属校验与 row→DTO 映射，
 * 让 HTTP route 只处理协议与状态码，不直接依赖底层存储。
 */

import type {
  ClientProfileDto,
  ClientProfileUpsertDto,
  ClientStatusDto,
} from '@fateclaw/contracts/chat';

import {
  createClientProfile,
  getClientProfile,
  getClientProfilesByUserId,
  softDeleteClientProfile,
  updateClientProfile,
  type ClientProfileWithStats,
} from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import type { ClientProfile } from '../../shared/types.js';
import type { SuccessResponse } from '@fateclaw/contracts/common';

/** 重名（唯一索引冲突）时返回的错误文案。 */
const CLIENT_NAME_CONFLICT_MESSAGE = '已存在同名客户，请换一个名字';

/** Postgres 唯一约束冲突错误码。 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * 归一化 gender：仅接受 '男'/'女'，其余（含空串/未定义）落为 null。
 *
 * @remarks 路由层已用 zod enum 校验，这里再兜底，避免内部调用绕过校验写入脏数据。
 */
function normalizeGender(
  gender: ClientProfileUpsertDto['gender'],
): '男' | '女' | null {
  return gender === '男' || gender === '女' ? gender : null;
}

/** 将空白字符串归一为 null，保留有内容的字符串（去首尾空白）。 */
function normalizeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 合法客户状态集合。 */
const VALID_CLIENT_STATUSES: ReadonlySet<string> = new Set([
  'vip',
  'follow_up',
  'done',
]);

/**
 * 归一化客户状态：仅接受 vip/follow_up/done，其余（含空/脏值）落为 null。
 *
 * @remarks 同时用于入参兜底和行→DTO 映射，故接受宽松的 string 输入。
 */
function normalizeStatus(
  status: string | null | undefined,
): ClientStatusDto | null {
  return status && VALID_CLIENT_STATUSES.has(status)
    ? (status as ClientStatusDto)
    : null;
}

/**
 * 归一化标签数组：去首尾空白、丢空串、去重，单标签截断 20 字，最多 12 个。
 *
 * @remarks 入库与出参均兜底，避免脏标签；非数组输入按空数组处理。
 */
function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().slice(0, 20);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 12) break;
  }
  return result;
}

/** 判断是否为 Postgres 唯一约束冲突。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * 客户档案行映射为对外稳定协议 DTO。
 *
 * @param profile 客户档案表行。
 * @param stats 可选的会话聚合统计（列表查询时提供）。
 */
export function toClientProfileDto(
  profile: ClientProfile,
  stats?: { session_count: number; last_session_at: string | null },
): ClientProfileDto {
  return {
    id: profile.id,
    name: profile.name,
    gender: normalizeGender(profile.gender as ClientProfileUpsertDto['gender']),
    solar_date: profile.solar_date ?? null,
    hour: profile.hour ?? null,
    minute: profile.minute ?? null,
    birthplace: profile.birthplace ?? null,
    notes: profile.notes ?? null,
    tags: normalizeTags(profile.tags),
    status: normalizeStatus(profile.status),
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    session_count: stats?.session_count,
    last_session_at: stats?.last_session_at ?? null,
  };
}

/** 列表行（含统计）映射为 DTO。 */
function toClientProfileDtoWithStats(
  row: ClientProfileWithStats,
): ClientProfileDto {
  return toClientProfileDto(row, {
    session_count: row.session_count,
    last_session_at: row.last_session_at,
  });
}

/**
 * 列出当前卦师的全部在档客户。
 *
 * @param userId 客户归属用户 ID。
 * @returns 客户档案 DTO 列表（含解读会话统计）。
 */
export async function listClientProfilesForOwnedUser(
  userId: string,
): Promise<ServiceResult<ClientProfileDto[]>> {
  const rows = await getClientProfilesByUserId(userId);
  return ok(rows.map(toClientProfileDtoWithStats));
}

/**
 * 读取当前卦师的单个客户档案。
 *
 * @param userId 客户归属用户 ID。
 * @param id 客户档案 ID。
 * @returns 客户档案 DTO；不存在或无权限时返回 404。
 */
export async function getClientProfileForOwnedUser(
  userId: string,
  id: string,
): Promise<ServiceResult<ClientProfileDto>> {
  const profile = await getClientProfile(id, userId);
  if (!profile) {
    return fail(404, '客户档案不存在');
  }
  return ok(toClientProfileDto(profile));
}

/**
 * 创建客户档案。
 *
 * @param userId 客户归属用户 ID。
 * @param input 创建/更新请求体。
 * @returns 新建客户档案 DTO；重名时返回 409。
 */
export async function createClientProfileForOwnedUser(
  userId: string,
  input: ClientProfileUpsertDto,
): Promise<ServiceResult<ClientProfileDto>> {
  const name = normalizeText(input.name);
  if (!name) {
    return fail(400, '请填写客户姓名');
  }

  try {
    const profile = await createClientProfile({
      userId,
      name,
      gender: normalizeGender(input.gender),
      solarDate: normalizeText(input.solar_date),
      hour: input.hour ?? null,
      minute: input.minute ?? null,
      birthplace: normalizeText(input.birthplace),
      notes: normalizeText(input.notes),
      tags: normalizeTags(input.tags),
      status: normalizeStatus(input.status),
    });
    return ok(toClientProfileDto(profile));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail(409, CLIENT_NAME_CONFLICT_MESSAGE);
    }
    logger.error({ userId, err: error }, '创建客户档案失败');
    throw error;
  }
}

/**
 * 更新客户档案。
 *
 * @param userId 客户归属用户 ID。
 * @param id 客户档案 ID。
 * @param input 创建/更新请求体（整体覆盖语义）。
 * @returns 更新后的客户档案 DTO；不存在或无权限时返回 404，重名时返回 409。
 */
export async function updateClientProfileForOwnedUser(
  userId: string,
  id: string,
  input: ClientProfileUpsertDto,
): Promise<ServiceResult<ClientProfileDto>> {
  const name = normalizeText(input.name);
  if (!name) {
    return fail(400, '请填写客户姓名');
  }

  // 先确认归属，避免对他人/已删除档案做 UPDATE 时无法区分 404 与无变更。
  const existing = await getClientProfile(id, userId);
  if (!existing) {
    return fail(404, '客户档案不存在');
  }

  try {
    const profile = await updateClientProfile(id, userId, {
      name,
      gender: normalizeGender(input.gender),
      solarDate: normalizeText(input.solar_date),
      hour: input.hour ?? null,
      minute: input.minute ?? null,
      birthplace: normalizeText(input.birthplace),
      notes: normalizeText(input.notes),
      tags: normalizeTags(input.tags),
      status: normalizeStatus(input.status),
    });
    if (!profile) {
      return fail(404, '客户档案不存在');
    }
    return ok(toClientProfileDto(profile));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail(409, CLIENT_NAME_CONFLICT_MESSAGE);
    }
    logger.error({ userId, id, err: error }, '更新客户档案失败');
    throw error;
  }
}

/**
 * 软删除客户档案。
 *
 * @param userId 客户归属用户 ID。
 * @param id 客户档案 ID。
 * @returns 成功响应；不存在或无权限时返回 404。
 */
export async function deleteClientProfileForOwnedUser(
  userId: string,
  id: string,
): Promise<ServiceResult<SuccessResponse>> {
  const deleted = await softDeleteClientProfile(id, userId);
  if (!deleted) {
    return fail(404, '客户档案不存在');
  }
  return ok({ success: true });
}

/** 判断排盘输入里某个键是否已带有效值（非空、非空串）。 */
function hasInputValue(
  input: Record<string, unknown>,
  key: string,
): boolean {
  const value = input[key];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * 用客户档案的生辰信息预填排盘输入。
 *
 * @param userId 客户归属用户 ID（owner 隔离）。
 * @param clientId 关联的客户档案 id；为空时直接返回原输入。
 * @param baseInput 本轮排盘输入。
 * @returns 合并后的排盘输入；本轮已填的字段优先，客户档案只补空缺。
 *
 * @remarks 字段名对齐 paipan-registry 的 bazi-paipan：solarDate/hour/minute/gender。
 *          客户档案不存在、无权限或缺少对应字段时按可用字段尽力补全，不抛错。
 */
export async function applyClientProfilePrefill(
  userId: string,
  clientId: string | undefined,
  baseInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!clientId) return baseInput;

  const profile = await getClientProfile(clientId, userId);
  if (!profile) return baseInput;

  const merged: Record<string, unknown> = { ...baseInput };
  // 仅在本轮未提供该字段时，用客户档案补全；本轮输入始终优先。
  if (!hasInputValue(merged, 'solarDate') && profile.solar_date) {
    merged.solarDate = profile.solar_date;
  }
  if (!hasInputValue(merged, 'hour') && profile.hour !== null) {
    merged.hour = profile.hour;
  }
  if (!hasInputValue(merged, 'minute') && profile.minute !== null) {
    merged.minute = profile.minute;
  }
  if (!hasInputValue(merged, 'gender') && profile.gender) {
    merged.gender = profile.gender;
  }
  return merged;
}
