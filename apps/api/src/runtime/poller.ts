/**
 * iLink 长轮询：每个账号一个独立的轮询循环。
 *
 * 消息处理与轮询解耦：收到消息后交给账号级有界执行器。
 * 同一网页 AI Chat session 的互斥由 session processing lock 负责；微信侧限制并发和待处理积压。
 */

import { updateAccount } from '#infrastructure/db';
import { getUpdates, IlinkAccount } from '#infrastructure/ilink';
import { logger } from '#infrastructure/logger';
import { processWeixinMessage } from '#modules/chat/message-handler';
import { Account } from '#shared/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pollingAccounts = new Map<string, AbortController>();
const messageLimiters = new Map<string, AccountMessageLimiter>();
const MAX_WEIXIN_MESSAGE_CONCURRENCY_PER_ACCOUNT = 3;
const MAX_WEIXIN_MESSAGE_BACKLOG_PER_ACCOUNT = 100;

class AccountMessageLimiter {
  private active = 0;
  private stopped = false;
  private readonly queue: Array<() => Promise<void>> = [];

  constructor(
    private readonly accountId: string,
    private readonly log: typeof logger,
  ) {}

  enqueue(task: () => Promise<void>, msgId?: string): boolean {
    if (this.stopped) return false;
    if (this.active < MAX_WEIXIN_MESSAGE_CONCURRENCY_PER_ACCOUNT) {
      this.run(task);
      return true;
    }
    if (this.queue.length >= MAX_WEIXIN_MESSAGE_BACKLOG_PER_ACCOUNT) {
      this.log.warn(
        {
          accountId: this.accountId,
          msgId,
          backlog: this.queue.length,
          limit: MAX_WEIXIN_MESSAGE_BACKLOG_PER_ACCOUNT,
        },
        'iLink 消息处理积压已满，丢弃新消息',
      );
      return false;
    }
    this.queue.push(task);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private run(task: () => Promise<void>): void {
    this.active += 1;
    void task()
      .catch((err) => {
        this.log.error({ err }, '消息处理失败');
      })
      .finally(() => {
        this.active -= 1;
        this.drain();
      });
  }

  private drain(): void {
    while (
      !this.stopped &&
      this.active < MAX_WEIXIN_MESSAGE_CONCURRENCY_PER_ACCOUNT
    ) {
      const next = this.queue.shift();
      if (!next) return;
      this.run(next);
    }
  }
}

function getMessageLimiter(
  accountId: string,
  log: typeof logger,
): AccountMessageLimiter {
  const existing = messageLimiters.get(accountId);
  if (existing) return existing;
  const limiter = new AccountMessageLimiter(accountId, log);
  messageLimiters.set(accountId, limiter);
  return limiter;
}

export function __createAccountMessageLimiterForTests(
  accountId: string,
  log: typeof logger,
): {
  enqueue(task: () => Promise<void>, msgId?: string): boolean;
  stop(): void;
} {
  return new AccountMessageLimiter(accountId, log);
}

export const __getWeixinMessageLimiterConfigForTests = () => ({
  maxConcurrency: MAX_WEIXIN_MESSAGE_CONCURRENCY_PER_ACCOUNT,
  maxBacklog: MAX_WEIXIN_MESSAGE_BACKLOG_PER_ACCOUNT,
});

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
  const limiter = messageLimiters.get(accountId);
  if (limiter) {
    limiter.stop();
    messageLimiters.delete(accountId);
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
  const limiter = getMessageLimiter(account.id, log);
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
          if (pollingAccounts.get(account.id) === abortController)
            pollingAccounts.delete(account.id);
          limiter.stop();
          if (messageLimiters.get(account.id) === limiter)
            messageLimiters.delete(account.id);
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
            limiter.enqueue(
              () =>
                processWeixinMessage(account, msg).catch((err) => {
                  log.error({ err, msgId: msg.message_id }, '消息处理失败');
                }),
              String(msg.message_id),
            );
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'iLink 轮询循环出错');
      await sleep(5000);
    }
  }
  if (pollingAccounts.get(account.id) === abortController)
    pollingAccounts.delete(account.id);
  const stoppedLimiter = messageLimiters.get(account.id);
  if (stoppedLimiter === limiter) {
    stoppedLimiter.stop();
    messageLimiters.delete(account.id);
  }
  log.info('iLink 长轮询已停止');
}
