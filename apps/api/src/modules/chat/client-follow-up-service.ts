/**
 * 客户跟进记录服务层。
 *
 * 负责跟进记录的增 / 查 / 软删、双重归属校验（当前用户 + 父客户归属）与 row→DTO 映射，
 * 让 HTTP route 只处理协议与状态码。
 */

import type {
  ClientFollowUpCreateDto,
  ClientFollowUpDto,
} from '@fateclaw/contracts/chat';

import {
  createClientFollowUp,
  getClientFollowUpsByClientId,
  getClientProfile,
  softDeleteClientFollowUp,
} from '../../infrastructure/db.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import type { ClientFollowUp } from '../../shared/types.js';
import type { SuccessResponse } from '@fateclaw/contracts/common';

/** 跟进正文最大长度，与路由 zod 校验保持一致。 */
const FOLLOW_UP_MAX_LENGTH = 1000;

/** 跟进记录行映射为对外稳定协议 DTO。 */
function toClientFollowUpDto(row: ClientFollowUp): ClientFollowUpDto {
  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
  };
}

/**
 * 列出某客户的全部跟进记录（时间线倒序）。
 *
 * @param userId 当前卦师 ID（owner 隔离）。
 * @param clientId 父客户档案 ID。
 * @returns 跟进记录 DTO 列表；父客户不存在或无权限时返回 404。
 */
export async function listClientFollowUpsForOwnedUser(
  userId: string,
  clientId: string,
): Promise<ServiceResult<ClientFollowUpDto[]>> {
  // 双重归属：先确认父客户属于当前卦师，防止越权读他人客户的跟进。
  const client = await getClientProfile(clientId, userId);
  if (!client) {
    return fail(404, '客户档案不存在');
  }
  const rows = await getClientFollowUpsByClientId(clientId, userId);
  return ok(rows.map(toClientFollowUpDto));
}

/**
 * 为某客户新增一条跟进记录。
 *
 * @param userId 当前卦师 ID（owner 隔离）。
 * @param clientId 父客户档案 ID。
 * @param input 跟进正文请求体。
 * @returns 新建跟进记录 DTO；父客户不存在返回 404，正文为空/超长返回 400。
 */
export async function createClientFollowUpForOwnedUser(
  userId: string,
  clientId: string,
  input: ClientFollowUpCreateDto,
): Promise<ServiceResult<ClientFollowUpDto>> {
  const content = input.content?.trim() ?? '';
  if (!content) {
    return fail(400, '请填写跟进内容');
  }
  if (content.length > FOLLOW_UP_MAX_LENGTH) {
    return fail(400, `跟进内容不能超过 ${FOLLOW_UP_MAX_LENGTH} 字`);
  }
  // 双重归属：先确认父客户属于当前卦师，防止越权给他人客户写跟进。
  const client = await getClientProfile(clientId, userId);
  if (!client) {
    return fail(404, '客户档案不存在');
  }
  const row = await createClientFollowUp({ userId, clientId, content });
  return ok(toClientFollowUpDto(row));
}

/**
 * 软删除某条跟进记录。
 *
 * @param userId 当前卦师 ID（owner 隔离）。
 * @param id 跟进记录 ID。
 * @returns 成功响应；不存在或无权限时返回 404。
 * @remarks 仅按 (id, user_id) 软删即可保证归属隔离，无需额外校验 clientId。
 */
export async function deleteClientFollowUpForOwnedUser(
  userId: string,
  id: string,
): Promise<ServiceResult<SuccessResponse>> {
  const deleted = await softDeleteClientFollowUp(id, userId);
  if (!deleted) {
    return fail(404, '跟进记录不存在');
  }
  return ok({ success: true });
}
