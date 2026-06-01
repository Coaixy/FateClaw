/**
 * 微信消息处理：解析消息、构建 prompt、分发给 Agent、处理失败兜底。
 */

import {
  getRecentMessages,
  getMembershipOverview,
  getUserByAccountId,
  storeMessage,
} from '../../infrastructure/db.js';
import { incrementDailyMessageCount } from '../../infrastructure/daily-usage.js';
import {
  sendMessage as ilinkSendMessage,
  parseWeixinMessage,
  WeixinMessage,
} from '../../infrastructure/ilink.js';
import { logger } from '../../infrastructure/logger.js';
import { mapInternalErrorToPublicError } from '../../shared/public-error.js';
import { getSoulContent } from '../../infrastructure/db.js';
import { dispatchResidentPrompt } from '../../runtime/resident-agent.js';
import {
  FREE_WECHAT_UNSUPPORTED_MESSAGE,
  isWechatDeviceBindingDisabled,
} from '../account/account-service.js';
import { resolveUserLlmRuntime } from '../system/system-config.js';
import {
  computeTokenBudget,
  estimateTokens,
  fillHistoryStructured,
  HistoryMessage,
  truncateToTokenBudget,
} from '../../shared/token-budget.js';
import { Account, NewMessage } from '../../shared/types.js';

export async function processWeixinMessage(
  account: Account,
  msg: WeixinMessage,
): Promise<void> {
  const log = logger.child({ accountId: account.id });
  const msgId = String(msg.message_id ?? `msg-${Date.now()}`);

  log.info({ msg_id: msgId, from: msg.from_user_id }, '处理消息');

  const parsed = parseWeixinMessage(msg, account.id);
  if (!parsed) return;

  const { content, sender, sender_name } = parsed;

  const owner = await getUserByAccountId(account.id);
  const membership = owner ? await getMembershipOverview(owner.id) : null;
  if (isWechatDeviceBindingDisabled(Boolean(membership?.active))) {
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

  // 存入数据库
  const newMessage: NewMessage = {
    id: msgId,
    account_id: account.id,
    sender,
    sender_name,
    content,
    timestamp:
      typeof msg.create_time_ms === 'number'
        ? new Date(msg.create_time_ms).toISOString()
        : new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  };
  await storeMessage(newMessage);

  try {
    if (!owner) {
      throw new Error('账号未绑定平台用户，无法处理 AI 请求');
    }
    const llmRuntime = await resolveUserLlmRuntime(owner.id);
    // 构建结构化上下文
    const structured = await buildStructuredInput(
      account,
      content,
      llmRuntime.model,
      llmRuntime.contextWindowTokens,
    );

    // 分发给 Agent
    const output = await dispatchResidentPrompt({
      accountId: account.id,
      type: 'chat',
      userMessage: structured.userMessage,
      history: structured.history,
      userName: structured.userName,
      assistantName: structured.assistantName,
      toUserId: sender,
      contextToken: msg.context_token,
      autoDeliver: true,
      llmRuntime,
    });
    if (output.status === 'error') {
      log.warn(
        { requestId: output.requestId, error: output.error },
        '常驻 agent 返回错误响应',
      );
    } else {
      const today = new Date().toISOString().slice(0, 10);
      await incrementDailyMessageCount(owner.id, today);
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

interface StructuredInput {
  userMessage: string;
  history: HistoryMessage[];
  userName: string;
  assistantName: string;
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

/**
 * 为 AI 对话（chat session）构建结构化输入。
 * 与 buildStructuredInput 的区别：
 * - AI 历史由 Pi session 文件负责，FateClaw DB 只保留业务展示副本
 * - 选中盘面、自贴盘面等显式上下文通过专用字段传入
 */
export async function buildStructuredInputForSession(
  identity: {
    runtimeId: string;
    userName: string;
    assistantName: string;
    soulAccountId?: string;
  },
  userMessage: string,
  sessionId: string,
  model: string,
  contextWindowTokens?: number,
): Promise<StructuredInput> {
  return {
    userMessage,
    history: [],
    userName: identity.userName,
    assistantName: identity.assistantName,
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
