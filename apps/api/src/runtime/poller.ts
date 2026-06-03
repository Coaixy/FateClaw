/**
 * iLink 长轮询：每个账号一个独立的轮询循环。
 *
 * 消息处理与轮询解耦：收到消息后 fire-and-forget 交给 processWeixinMessage。
 * 同一网页 AI Chat session 的互斥由 session processing lock 负责；微信侧不做排队。
 */

import { updateAccount } from '../infrastructure/db.js';
import { getUpdates, IlinkAccount } from '../infrastructure/ilink.js';
import { logger } from '../infrastructure/logger.js';
import { processWeixinMessage } from '../modules/chat/message-handler.js';
import { Account } from '../shared/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pollingAccounts = new Map<string, AbortController>();

/**
 * 停止指定账号的轮询循环。删除账号 / 禁用账号时调用。
 * 已发出的 getUpdates 请求不会被中断，但拿到响应后会立即跳出循环。
 */
export function stopAccountPolling(accountId: string): void {
  const controller = pollingAccounts.get(accountId);
  if (controller) {
    controller.abort();
    pollingAccounts.delete(accountId);
  }
}

export async function startAccountPolling(account: Account): Promise<void> {
  if (!account.enabled) {
    logger.debug({ accountId: account.id }, '账号已禁用，跳过轮询');
    return;
  }

  if (pollingAccounts.has(account.id)) {
    logger.debug({ accountId: account.id }, '账号已在轮询中，跳过');
    return;
  }
  const abortController = new AbortController();
  pollingAccounts.set(account.id, abortController);

  const log = logger.child({ accountId: account.id });
  log.info('开始 iLink 长轮询');

  const ilinkAccount: IlinkAccount = {
    id: account.id,
    bot_token: account.bot_token,
    base_url: account.base_url,
  };

  let buf = account.get_updates_buf ?? '';

  while (!abortController.signal.aborted) {
    try {
      const resp = await getUpdates(ilinkAccount, buf);
      if (abortController.signal.aborted) break;

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        log.error(
          { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg },
          'getUpdates 出错',
        );

        // session timeout 不可恢复，需要重新登录
        if (resp.errcode === -14) {
          log.warn('会话已过期，禁用账号并停止轮询');
          await updateAccount(account.id, { enabled: false });
          pollingAccounts.delete(account.id);
          return;
        }

        await sleep(5000);
        continue;
      }

      if (resp.get_updates_buf && resp.get_updates_buf !== buf) {
        buf = resp.get_updates_buf;
        await updateAccount(account.id, { get_updates_buf: buf });
      }

      if (resp.msgs && resp.msgs.length > 0) {
        log.info({ count: resp.msgs.length }, '收到消息');
        for (const msg of resp.msgs) {
          if (msg.message_type === 1) {
            void processWeixinMessage(account, msg).catch((err) => {
              log.error({ err, msgId: msg.message_id }, '消息处理失败');
            });
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'iLink 轮询循环出错');
      await sleep(5000);
    }
  }
  pollingAccounts.delete(account.id);
  log.info('iLink 长轮询已停止');
}
