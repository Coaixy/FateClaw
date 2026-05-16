/**
 * recall_history 工具 — 检索更早的对话历史。
 *
 * 从 Redis 中扫描历史消息记录，支持按关键词和时间范围过滤。
 * 用于弥补当前上下文窗口只包含最近几轮对话的限制。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';
import { formatLocalDateTimeShort } from '../../utils/format-time.js';

/**
 * 将 time_range 枚举转为起止 Date。
 */
function resolveTimeRange(
  range: string,
  timezone: string,
): { start: Date; end: Date } {
  const now = new Date();
  // 用本地时区的"今天 00:00"作为基准
  const todayStr = now.toLocaleDateString('sv-SE', { timeZone: timezone }); // yyyy-MM-dd
  const todayStart = new Date(`${todayStr}T00:00:00`);

  switch (range) {
    case 'today':
      return { start: todayStart, end: now };
    case 'yesterday': {
      const yd = new Date(todayStart.getTime() - 86_400_000);
      return { start: yd, end: todayStart };
    }
    case 'last_3_days':
      return {
        start: new Date(todayStart.getTime() - 3 * 86_400_000),
        end: now,
      };
    case 'last_week':
      return {
        start: new Date(todayStart.getTime() - 7 * 86_400_000),
        end: now,
      };
    case 'last_month':
      return {
        start: new Date(todayStart.getTime() - 30 * 86_400_000),
        end: now,
      };
    default:
      return { start: new Date(0), end: now };
  }
}

export const recallHistory: ToolSpec = {
  executionMode: 'parallel',
  definition: {
    type: 'function',
    function: {
      name: 'recall_history',
      description:
        '检索更早的对话历史。默认上下文只包含最近几轮对话，当用户提及之前的话题、需要回顾过去的对话时使用此工具。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '关键词搜索（可选），匹配消息内容',
          },
          time_range: {
            type: 'string',
            enum: [
              'today',
              'yesterday',
              'last_3_days',
              'last_week',
              'last_month',
            ],
            description: '时间范围过滤（可选）',
          },
          limit: {
            type: 'number',
            description: '返回最大条数，默认 15',
          },
        },
      },
    },
  },

  prompt: `## recall_history — 回忆对话历史

从历史消息存储中检索更早的对话记录。

### 为什么需要这个工具
当前对话上下文只包含最近若干轮的对话消息（受上下文窗口大小限制）。
当用户提到更早的话题、要求回忆之前的对话时，需要使用此工具主动检索历史记录。

### 使用场景
- 用户说"之前聊过的那个话题""上次说的..."等回溯性表达。
- 用户询问"我昨天说了什么""上周我们聊了什么"。
- 需要查找某个特定话题或关键词相关的历史对话。
- 补充当前上下文中缺失的信息。

### 参数说明
- **keyword**（可选）：对消息内容进行关键词搜索，不区分大小写。只返回包含该关键词的消息。
- **time_range**（可选）：按时间范围过滤。可选值：
  - \`today\` — 今天
  - \`yesterday\` — 昨天
  - \`last_3_days\` — 最近 3 天
  - \`last_week\` — 最近 7 天
  - \`last_month\` — 最近 30 天
- **limit**（可选）：返回的最大条数，默认 15 条，最大 50 条。

### 返回格式
- 按时间正序排列。
- 每条消息包含时间、角色（User/Assistant）和内容。

### 注意事项
- 最多扫描最近 500 条消息记录。
- keyword 和 time_range 可以组合使用以缩小搜索范围。
- 如果没有匹配结果，会返回相应提示。`,

  execute: async (args: Record<string, unknown>, options) => {
    const keyword = args.keyword as string | undefined;
    const timeRange = args.time_range as string | undefined;
    const limitArg = args.limit as number | undefined;

    const accountId = getContext().accountId;
    const timezone = getContext().timezone;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();
    const maxScan = 500;
    const resultLimit = limitArg && limitArg > 0 ? Math.min(limitArg, 50) : 15;

    // 从存储读取历史（LPUSH 存储，索引 0 = 最新）
    const raw = await deps.historyStore.listRecent(accountId, maxScan);

    if (raw.length === 0) {
      return { output: '暂无可检索的历史对话记录。' };
    }

    // 解析 + 过滤
    const timeFilter = timeRange ? resolveTimeRange(timeRange, timezone) : null;
    const keywordLower = keyword?.toLowerCase();

    const matched: { role: string; content: string; time: string }[] = [];

    for (const entry of raw) {
      if (matched.length >= resultLimit) break;

      let msg: {
        sender_name?: string;
        content: string;
        timestamp: string;
        is_from_me: boolean;
      };
      try {
        msg = JSON.parse(entry);
      } catch {
        continue;
      }

      // 时间过滤
      if (timeFilter) {
        const ts = new Date(msg.timestamp);
        if (ts < timeFilter.start || ts > timeFilter.end) continue;
      }

      // 关键词过滤
      if (keywordLower && !msg.content.toLowerCase().includes(keywordLower))
        continue;

      const role = msg.is_from_me ? 'Assistant' : msg.sender_name || 'User';
      const localTime = formatLocalDateTimeShort(
        new Date(msg.timestamp),
        timezone,
      );

      matched.push({ role, content: msg.content, time: localTime });
    }

    if (matched.length === 0) {
      const hint = [
        keyword ? `关键词"${keyword}"` : null,
        timeRange ? `时间范围"${timeRange}"` : null,
      ]
        .filter(Boolean)
        .join('、');
      return { output: `未找到匹配的历史记录${hint ? `（${hint}）` : ''}。` };
    }

    // 按时间正序输出（matched 当前是倒序）
    matched.reverse();
    const lines = matched.map((m) => `[${m.time}] ${m.role}: ${m.content}`);

    return {
      output: `找到 ${matched.length} 条历史记录:\n\n${lines.join('\n')}`,
    };
  },
};
