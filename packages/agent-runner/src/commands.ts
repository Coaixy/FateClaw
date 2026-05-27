/**
 * 固定指令处理。
 *
 * 以 "/" 开头的消息会被拦截：
 * - 直接返回 text → 不经过 AI
 * - 返回 rewrite → 改写用户消息后交给 AI 处理
 */

import type { AgentRuntimeDeps } from './deps.js';
import { getDefaultAgentRuntimeDeps } from './deps.js';
import {
  loadEnabledSkillNames,
  loadSkillMetadataList,
} from './skill-metadata.js';

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
    description: '让 AI 总结长期记忆',
    execute: async (accountId, _args, deps) => {
      try {
        const content = await deps.memoryStore.read(accountId);
        if (!content.trim()) {
          return { text: '长期记忆为空。' };
        }
      } catch {
        return { text: '读取记忆失败。' };
      }

      return {
        text: '',
        rewrite:
          '请调用 read_memory 读取我的长期记忆，然后用简洁的方式总结你对我的了解。',
      };
    },
  },

  skills: {
    description: '查看 Skills 列表及开启状态',
    execute: async (accountId, _args, deps) => {
      const allSkills = await loadSkillMetadataList(undefined, accountId, deps);
      if (allSkills.length === 0) {
        return { text: '当前没有可用的 Skills。' };
      }

      const enabledList = await loadEnabledSkillNames(deps);
      const enabledSet = new Set(enabledList);

      const lines = ['Skills 列表：', ''];
      for (const skill of allSkills) {
        // 用户 Skill 在 DB 查询中已按 enabled=true 过滤，直接显示为启用
        const isEnabled =
          skill.type === 'user'
            ? true
            : enabledSet !== null
              ? enabledSet.has(skill.name)
              : true;
        const icon = isEnabled ? '✅' : '❌';
        const tag = skill.type === 'user' ? ' [自定义]' : '';
        lines.push(`  ${icon} ${skill.name}${tag} — ${skill.description}`);
      }
      lines.push(
        '',
        '告诉我要开启或关闭哪个 Skill，我来帮你操作。',
      );
      return { text: lines.join('\n') };
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
    execute: async (accountId, _args, deps) => {
      try {
        const tasks = await deps.taskStore.list(accountId);

        if (tasks.length === 0) {
          return { text: '当前没有已设置的提醒。' };
        }

        const lines = ['提醒列表：', ''];
        for (const task of tasks) {
          const statusIcon =
            task.status === 'active'
              ? '✅'
              : task.status === 'paused'
                ? '⏸️'
                : '❌';
          lines.push(
            `  ${statusIcon} [${task.id}]`,
            `     ${task.prompt.slice(0, 60)}`,
            `     ${task.schedule_type}: ${task.schedule_value} | 下次: ${task.next_run || 'N/A'}`,
            '',
          );
        }
        return { text: lines.join('\n') };
      } catch {
        return { text: '读取提醒列表失败。' };
      }
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
