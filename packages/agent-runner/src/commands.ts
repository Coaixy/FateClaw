/**
 * 固定指令处理。
 *
 * 以 "/" 开头的消息会被拦截：
 * - 直接返回 text → 不经过 AI
 * - 返回 rewrite → 改写用户消息后交给 AI 处理
 */

import type { AgentRuntimeDeps } from './deps.js';
import { getDefaultAgentRuntimeDeps } from './deps.js';

export interface CommandResult {
  text: string;
  /** 若设置，则将此字符串作为用户消息交给 AI 处理，text 被忽略 */
  rewrite?: string;
  /** 若设置为 true，宿主机将清除该账号的对话历史 */
  clearHistory?: boolean;
}

interface CommandHandler {
  description: string;
  execute: (
    accountId: string,
    args: string,
    deps: AgentRuntimeDeps,
  ) => CommandResult | Promise<CommandResult>;
}

const commands: Record<string, CommandHandler> = {
  help: {
    description: '显示可用指令列表',
    execute: (_accountId, _args, _deps) => {
      const lines = ['可用指令：', ''];
      for (const [name, handler] of Object.entries(commands)) {
        lines.push(`  /${name} — ${handler.description}`);
      }
      lines.push('', '其他消息将由 AI 处理。');
      return { text: lines.join('\n') };
    },
  },

  status: {
    description: '查看 agent 是否在线',
    execute: (_accountId, _args, _deps) => {
      return { text: 'ok' };
    },
  },

  memory: {
    description: '查看长期记忆状态',
    execute: async (_accountId, _args, _deps) => {
      return { text: '长期记忆由 Web/API 控制面管理，Pi session 会在请求上下文中自动使用。' };
    },
  },

  skills: {
    description: '查看 Skills 列表及开启状态',
    execute: async (_accountId, _args, _deps) => {
      return { text: 'Skills 目录与启停由 Web/API 控制面管理；Pi 只会读取本轮授权的用户知识资源。' };
    },
  },

  new: {
    description: '开启新对话（清除上下文）',
    execute: (_accountId, _args, _deps) => {
      return { text: '好的，对话已重置，现在是全新的开始 ✨', clearHistory: true };
    },
  },

  reminders: {
    description: '查看已设置的提醒',
    execute: async (_accountId, _args, _deps) => {
      return { text: '提醒由 Web/API 控制面管理，Pi session 不再直接创建或查询提醒。' };
    },
  },
};

/**
 * 尝试匹配并执行指令。
 * 返回 null 表示消息不是指令，应继续走 AI 处理。
 */
export async function tryExecuteCommand(
  accountId: string,
  userMessage: string,
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): Promise<CommandResult | null> {
  const trimmed = userMessage.trim();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const commandName =
    spaceIdx === -1
      ? trimmed.slice(1).toLowerCase()
      : trimmed.slice(1, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const handler = commands[commandName];
  if (!handler) {
    return commands.help.execute(accountId, '', deps);
  }

  return handler.execute(accountId, args, deps);
}
