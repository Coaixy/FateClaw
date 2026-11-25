import { getChatSession } from '#infrastructure/db';
import { fail, ok, type ServiceResult } from '#shared/service-result';
import type { ChatSession } from '#shared/types';

export async function getOwnedSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<ChatSession>> {
  const session = await getChatSession(sessionId);
  if (!session) {
    return fail(404, '会话不存在');
  }

  if (session.user_id !== userId) {
    return fail(403, '无权操作');
  }

  return ok(session);
}
