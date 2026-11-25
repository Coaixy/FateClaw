import { adminRequest } from './admin-http';
import type {
  AdminMessagesResponse,
  AdminChatSessionsResponse,
  AdminChatSessionDetailResponse,
  AdminPiSessionCleanupResult,
  AdminPiSessionOrphanScanResult,
  AdminPiSessionOrphanScanAction,
} from './admin-api';

export const adminConversationsApi = {
  messages: (opts?: {
    account_id?: string;
    user_id?: string;
    session_id?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.account_id) params.set('account_id', opts.account_id);
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.session_id) params.set('session_id', opts.session_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return adminRequest<AdminMessagesResponse>(
      `/api/admin/messages${qs ? `?${qs}` : ''}`,
    );
  },
  chatSessions: (opts?: {
    account_id?: string;
    user_id?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.account_id) params.set('account_id', opts.account_id);
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return adminRequest<AdminChatSessionsResponse>(
      `/api/admin/chat-sessions${qs ? `?${qs}` : ''}`,
    );
  },
  /** 查看任意会话的完整内容（消息 + 卦象 + 关联客户档案）。 */
  chatSessionDetail: (sessionId: string) =>
    adminRequest<AdminChatSessionDetailResponse>(
      `/api/admin/chat-sessions/${encodeURIComponent(sessionId)}`,
    ),
  cleanupPiSessions: (data: {
    mode: 'soft_deleted' | 'inactive';
    inactive_days?: number;
  }) =>
    adminRequest<AdminPiSessionCleanupResult>(
      '/api/admin/chat-sessions/pi-sessions/cleanup',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
  scanPiSessionOrphans: (data: {
    action?: AdminPiSessionOrphanScanAction;
    limit?: number;
    sample_limit?: number;
  }) =>
    adminRequest<AdminPiSessionOrphanScanResult>(
      '/api/admin/chat-sessions/pi-sessions/orphans/scan',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
};
