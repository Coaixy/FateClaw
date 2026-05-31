/**
 * IPC tasks 队列处理：提醒调度、技能管理、记忆写入。
 */

import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../infrastructure/config.js';
import {
  getAccount,
  getMembershipOverview,
  getTaskById,
  getUserByAccountId,
} from '../infrastructure/db.js';
import {
  ReminderAction,
  resolveAccountId,
  validateReminderActionPayload,
  validateSchedulePayload,
} from './ipc-payloads.js';
import { logger } from '../infrastructure/logger.js';
import { FREE_WECHAT_UNSUPPORTED_MESSAGE } from '../modules/account/account-service.js';
import { isWebChatRuntimeId } from '../modules/chat/web-chat-runtime.js';
import {
  deleteTaskAndSync,
  updateTaskAndSync,
} from '../modules/tasks/task-sync.js';
import { ScheduledTask } from '../shared/types.js';

function computeNextRunFromNow(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      return CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      })
        .next()
        .toISOString();
    } catch {
      return null;
    }
  }

  if (scheduleType === 'interval') {
    const milliseconds = parseInt(scheduleValue, 10);
    if (Number.isNaN(milliseconds) || milliseconds <= 0) {
      return null;
    }
    return new Date(Date.now() + milliseconds).toISOString();
  }

  const timestamp = new Date(scheduleValue);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }
  return timestamp.toISOString();
}

async function applyReminderAction(
  accountId: string,
  taskId: string,
  action: ReminderAction,
): Promise<void> {
  const task = await getTaskById(taskId);
  if (!task || task.account_id !== accountId) {
    logger.warn({ accountId, taskId, action }, '提醒任务未找到');
    return;
  }

  if (action === 'cancel') {
    await deleteTaskAndSync(taskId, accountId);
    logger.info({ accountId, taskId, action }, '提醒任务已删除');
    return;
  }

  if (action === 'pause') {
    await updateTaskAndSync(taskId, accountId, { status: 'paused' });
    logger.info({ accountId, taskId, action }, '提醒任务已暂停');
    return;
  }

  const nextRun = computeNextRunFromNow(
    task.schedule_type,
    task.schedule_value,
  );
  await updateTaskAndSync(taskId, accountId, {
    status: 'active',
    next_run: nextRun ?? task.next_run,
  });
  logger.info(
    { accountId, taskId, action, nextRun: nextRun ?? task.next_run },
    '提醒任务已恢复',
  );
}

async function assertMembershipWechatAccount(accountId: string): Promise<void> {
  const owner = await getUserByAccountId(accountId);
  if (!owner) {
    throw new Error(`提醒请求对应账号未绑定平台用户: ${accountId}`);
  }
  const membership = await getMembershipOverview(owner.id);
  if (!membership.active) {
    throw new Error(FREE_WECHAT_UNSUPPORTED_MESSAGE);
  }
}

export async function processTaskPayload(
  payload: unknown,
  fallbackAccountId?: string,
): Promise<void> {
  if (validateSchedulePayload(payload)) {
    const accountId = await resolveAccountId(
      payload.accountId,
      fallbackAccountId,
    );
    if (!accountId) {
      throw new Error('无法为提醒请求解析 accountId');
    }

    if (isWebChatRuntimeId(accountId)) {
      throw new Error('站内 AI Chat 暂不支持创建微信 BOT 定时任务');
    }

    const account = await getAccount(accountId);
    if (!account) {
      throw new Error(`提醒请求对应账号不存在: ${accountId}`);
    }
    await assertMembershipWechatAccount(account.id);

    if (!(await getTaskById(payload.taskId!))) {
      throw new Error(FREE_WECHAT_UNSUPPORTED_MESSAGE);
    } else {
      logger.info(
        { accountId, taskId: payload.taskId },
        'IPC 提醒任务已忽略，任务已存在',
      );
    }

    return;
  }

  if (validateReminderActionPayload(payload)) {
    const accountId = await resolveAccountId(
      payload.accountId,
      fallbackAccountId,
    );
    if (!accountId) {
      throw new Error('无法为提醒操作解析 accountId');
    }

    if (isWebChatRuntimeId(accountId)) {
      throw new Error('站内 AI Chat 暂不支持管理微信 BOT 定时任务');
    }

    if (!(await getAccount(accountId))) {
      throw new Error(`提醒操作对应账号不存在: ${accountId}`);
    }
    await assertMembershipWechatAccount(accountId);

    const action = payload.type.replace('_reminder', '') as ReminderAction;
    await applyReminderAction(accountId, payload.taskId!, action);
    return;
  }

  throw new Error('未知的 tasks IPC 消息类型');
}
