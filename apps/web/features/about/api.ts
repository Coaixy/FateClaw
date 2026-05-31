import { requestJson } from '@/lib/http/client';

/** 关于页面公开收支流水类型。 */
export type PublicAboutLedgerEntryType = 'income' | 'expense';

/** 关于页面公开收支流水记录。 */
export interface PublicAboutLedgerEntry {
  id: string;
  entry_type: PublicAboutLedgerEntryType;
  occurred_at: string;
  content: string;
  amount_yuan: number;
  created_at: string;
  updated_at: string;
}

/** 关于页面公开收支流水响应。 */
export interface PublicAboutLedgerResponse {
  entries: PublicAboutLedgerEntry[];
}

/** 关于页面公开接口客户端。 */
export const aboutApi = {
  ledger: () =>
    requestJson<PublicAboutLedgerResponse>('/api/public/financial-ledger'),
};
