/**
 * 微信消息处理：解析消息、构建 prompt、分发给 Agent、处理失败兜底。
 */

import {
  getUserByAccountId,
  storeMessage,
} from '#infrastructure/db';
import {
  sendMessage as ilinkSendMessage,
  parseWeixinMessage,
  WeixinMessage,
} from '#infrastructure/ilink';
import { logger } from '#infrastructure/logger';
import { mapInternalErrorToPublicError } from '#shared/public-error';
import {
  FREE_WECHAT_UNSUPPORTED_MESSAGE,
} from '#modules/account/account-service';
import { getRuntimeEntitlementSnapshot } from '#modules/billing/entitlements';
import { Account, NewMessage } from '#shared/types';
import {
  handleWechatChatCommand,
  runWechatChatSessionTurn,
  WECHAT_CHAT_THINKING_ACK,
} from './wechat-chat-session-service.js';

export { buildStructuredInputForSession } from './structured-input.js';

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
  const entitlement = owner
    ? await getRuntimeEntitlementSnapshot(owner.id)
    : null;
  if (!entitlement?.canUseWechatClaw) {
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
      errorMessage.includes('积分不足') ||
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
