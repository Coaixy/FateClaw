/**
 * 微信消息处理：解析消息、构建 prompt、分发给 Agent、处理失败兜底。
 */

import crypto from 'crypto';

import {
  getRecentMessages,
  getMembershipOverview,
  getUserByAccountId,
  storeMessage,
} from '../../infrastructure/db.js';
import {
  sendMessage as ilinkSendMessage,
  parseWeixinMessage,
  WeixinMessage,
} from '../../infrastructure/ilink.js';
import { logger } from '../../infrastructure/logger.js';
import { hasBaseMembershipEntitlement } from '../../shared/membership-plans.js';
import { mapInternalErrorToPublicError } from '../../shared/public-error.js';
import { getSoulContent } from '../../infrastructure/db.js';
import {
  FREE_WECHAT_UNSUPPORTED_MESSAGE,
  isWechatDeviceBindingDisabled,
} from '../account/account-service.js';
import {
  computeTokenBudget,
  estimateTokens,
  fillHistoryStructured,
  HistoryMessage,
  truncateToTokenBudget,
} from '../../shared/token-budget.js';
import { Account, NewMessage } from '../../shared/types.js';
import type { StructuredInput } from './structured-input.js';
import {
  handleWechatChatCommand,
  runWechatChatSessionTurn,
  WECHAT_CHAT_THINKING_ACK,
} from './wechat-chat-session-service.js';

export { buildStructuredInputForSession } from './structured-input.js';

/**
 * 构建旧版微信独立聊天在 Pi Runtime 中使用的稳定会话 ID。
 *
 * @param accountId 微信 Claw 账号 ID。
 * @param sender 微信侧发送方 ID。
 * @returns 去标识化后的 Pi Runtime 会话 ID。
 * @remarks 普通微信消息已接入网页 AI Chat session；此 helper 保留给兼容旧独立会话场景。
 */
export function buildWeixinRuntimeSessionId(
  accountId: string,
  sender: string,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${accountId}:${sender}`)
    .digest('hex')
    .slice(0, 32);
  return `wx-${digest}`;
}

export async function processWeixinMessage(
  account: Account,
  msg: WeixinMessage,
): Promise<void> {
  const log = logger.child({ accountId: account.id });
  const msgId = String(msg.message_id ?? `msg-${Date.now()}`);

  log.info({ msg_id: msgId, from: msg.from_user_id }, '处理消息');

  const parsed = parseWeixinMessage(msg, account.id);
  if (!parsed) return;

  const { content, sender } = parsed;

  const owner = await getUserByAccountId(account.id);
  const membership = owner ? await getMembershipOverview(owner.id) : null;
  if (isWechatDeviceBindingDisabled(hasBaseMembershipEntitlement(membership))) {
    await ilinkSendMessage(
      {
        id: account.id,
        bot_token: account.bot_token,
        base_url: account.base_url,
      },
      sender,
      FREE_WECHAT_UNSUPPORTED_MESSAGE,
      msg.context_token,
    );
    return;
  }

  try {
    if (!owner) {
      throw new Error('账号未绑定平台用户，无法处理 AI 请求');
    }

    const command = await handleWechatChatCommand({
      account,
      owner,
      sender,
      content,
    });
    if (command.handled) {
      if (command.replyText) {
        await ilinkSendMessage(
          {
            id: account.id,
            bot_token: account.bot_token,
            base_url: account.base_url,
          },
          sender,
          command.replyText,
          msg.context_token,
        );
      }
      return;
    }

    const result = await runWechatChatSessionTurn({
      account,
      owner,
      sender,
      messageId: msgId,
      content,
      onAccepted: () =>
        ilinkSendMessage(
          {
            id: account.id,
            bot_token: account.bot_token,
            base_url: account.base_url,
          },
          sender,
          WECHAT_CHAT_THINKING_ACK,
          msg.context_token,
        ).then(() => undefined),
    });
    if (result.status === 'discarded') {
      return;
    }

    for (const message of result.finalAssistantMessages ?? []) {
      if (!message.content.trim()) continue;
      await ilinkSendMessage(
        {
          id: account.id,
          bot_token: account.bot_token,
          base_url: account.base_url,
        },
        sender,
        message.content,
        msg.context_token,
      );
    }
  } catch (err) {
    log.error({ err }, '容器 agent 失败');
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (
      errorMessage.includes('余额不足') ||
      errorMessage.includes('欠费') ||
      errorMessage.includes('免费对话额度')
    ) {
      await ilinkSendMessage(
        {
          id: account.id,
          bot_token: account.bot_token,
          base_url: account.base_url,
        },
        sender,
        errorMessage,
        msg.context_token,
      );
      return;
    }
    const publicError = mapInternalErrorToPublicError(errorMessage);
    await sendFallbackReply(
      account,
      sender,
      msgId,
      msg.context_token,
      publicError.publicMessage,
    );
  }
}

function buildHistoryViews(args: {
  recentMsgs: Awaited<ReturnType<typeof getRecentMessages>>;
  historyBudget: number;
  skillContextBudget: number;
}): {
  history: HistoryMessage[];
  routingHistory: HistoryMessage[];
} {
  return {
    history: fillHistoryStructured(
      args.recentMsgs,
      args.historyBudget,
      args.skillContextBudget,
    ),
    routingHistory: fillHistoryStructured(
      args.recentMsgs,
      args.historyBudget,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export async function buildStructuredInput(
  account: Account,
  userMessage: string,
  model: string,
  contextWindowTokens?: number,
): Promise<StructuredInput> {
  const budget = computeTokenBudget(model, userMessage, {
    contextWindowTokens,
  });

  // Soul 不再塞进 prompt（agent-runtime system prompt 已自动注入摘要）
  // 但仍计算 soul 实际占用，把未用预算让给对话历史
  let soulActual = 0;
  const soulRaw = await getSoulContent(account.id);
  if (soulRaw) {
    const truncated = truncateToTokenBudget(soulRaw, budget.soulBudget);
    soulActual = estimateTokens(truncated);
  }
  const historyBudget = budget.historyBudget + (budget.soulBudget - soulActual);

  // 按 history 预算估算能装多少条消息（平均每条 ~200 tokens），
  // 加 20% 冗余多拉一些，fillHistoryStructured 会按预算精确截断。
  const estimatedMsgCount = Math.max(
    10,
    Math.ceil((historyBudget / 200) * 1.2),
  );
  const recentMsgs = await getRecentMessages(
    account.id,
    estimatedMsgCount,
    undefined,
  );
  const { history } = buildHistoryViews({
    recentMsgs,
    historyBudget,
    skillContextBudget: budget.skillContextBudget,
  });

  logger.debug(
    {
      accountId: account.id,
      model,
      contextWindow: budget.contextWindow,
      outputReserve: budget.outputReserve,
      toolLoopReserve: budget.toolLoopReserve,
      contentBudget: budget.contentBudget,
      soulBudget: budget.soulBudget,
      soulActual,
      historyBudget,
      historyMessages: history.length,
      totalMessages: recentMsgs.length,
    },
    'Token 预算分配',
  );

  return {
    userMessage,
    history,
    userName: account.name,
    assistantName: account.name,
  };
}

async function sendFallbackReply(
  account: Account,
  sender: string,
  msgId: string,
  contextToken?: string,
  text = '抱歉，AI 服务暂时不可用',
): Promise<void> {
  const log = logger.child({ accountId: account.id });
  const response = text;

  try {
    await ilinkSendMessage(
      {
        id: account.id,
        bot_token: account.bot_token,
        base_url: account.base_url,
      },
      sender,
      response,
      contextToken,
    );
    log.info({ to: sender }, '已通过 iLink 发送兜底回复');
  } catch (sendErr) {
    log.error({ err: sendErr, to: sender }, '通过 iLink 发送兜底回复失败');
  }

  const botMsg: NewMessage = {
    id: `${msgId}_reply_fallback`,
    account_id: account.id,
    sender: account.id,
    sender_name: account.name,
    content: response,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
  };
  await storeMessage(botMsg);
}
