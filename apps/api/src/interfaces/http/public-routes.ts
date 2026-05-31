import { FastifyInstance } from 'fastify';

import { listPublicFinancialLedgerEntries } from '../../infrastructure/db.js';

/**
 * 注册无需登录的公开接口。
 *
 * 当前仅暴露关于页面收支流水，避免公开页面依赖管理端鉴权接口。
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/public/financial-ledger — 关于页面公开收支流水
  app.get('/financial-ledger', async () => {
    return { entries: await listPublicFinancialLedgerEntries() };
  });
}
