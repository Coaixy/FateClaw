/**
 * Web 聊天服务层。
 *
 * 负责账号归属校验和消息读取，
 * 让消息 HTTP 路由保持轻量。
 */

import type { MessageDto } from '@nanoclaw/contracts/chat';

import {
  getAccountsByUserId,
  getRecentMessages,
} from '../../infrastructure/db.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import { toMessageDto } from '../../contracts-adapter/chat-contract.js';

export async function listMessagesForOwnedAccount(
  userId: string,
  accountId: string,
  limit: number,
  before?: string,
): Promise<ServiceResult<MessageDto[]>> {
  const accounts = await getAccountsByUserId(userId);
  const owns = accounts.some((account) => account.id === accountId);
  if (!owns) {
    return fail(403, '无权访问该账号的消息');
  }

  const messages = await getRecentMessages(accountId, limit, before);
  return ok(messages.map(toMessageDto));
}
