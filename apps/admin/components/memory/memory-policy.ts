import type { MemoryRuntimePolicy } from '@fateclaw/contracts/memory';

type NumberKey = Exclude<
  {
    [Key in keyof MemoryRuntimePolicy]: MemoryRuntimePolicy[Key] extends number
      ? Key
      : never;
  }[keyof MemoryRuntimePolicy],
  'revision'
>;

export const MEMORY_POLICY_GROUPS: Array<{
  title: string;
  fields: Array<[NumberKey, string, string]>;
}> = [
  {
    title: '整理任务',
    fields: [
      ['worker_concurrency', '工作并发数', '同时处理的记忆后台任务数量。'],
      ['job_timeout_ms', '任务超时（毫秒）', '单次任务执行的最长时间。'],
      ['max_attempts', '最大尝试次数', '包含首次执行，超出后标记失败。'],
      ['backfill_batch_size', '历史回填批次大小', '每批处理的历史消息数量。'],
    ],
  },
  {
    title: '提炼与每日预算',
    fields: [
      [
        'extraction_input_tokens',
        '单次提炼输入 token 上限',
        '限制每次进入提炼模型的来源长度。',
      ],
      [
        'extraction_output_tokens',
        '单次提炼输出 token 上限',
        '限制每次提炼生成的内容长度。',
      ],
      [
        'daily_token_budget',
        '每日生成 token 预算',
        '记忆后台模型的每日 token 预算。',
      ],
    ],
  },
  {
    title: '跨对话召回',
    fields: [
      [
        'recall_token_budget',
        '召回上下文 token 上限',
        '每次对话最多注入的长期记忆长度。',
      ],
      ['recall_max_results', '最多召回条数', '每次召回最多返回的记忆条数。'],
      ['recall_timeout_ms', '召回超时（毫秒）', '超时后由运行时处理降级。'],
      ['recent_source_limit', '最近来源条数', '召回时保留的最近来源数量。'],
    ],
  },
];

export const MEMORY_NUMBER_KEYS: NumberKey[] = MEMORY_POLICY_GROUPS.flatMap(
  (group) => group.fields.map(([key]) => key),
);

export type MemoryPolicyDraft = Omit<MemoryRuntimePolicy, NumberKey> &
  Record<NumberKey, string>;

function isSupportedNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export function createMemoryPolicyDraft(
  policy: MemoryRuntimePolicy,
): MemoryPolicyDraft {
  const numbers = Object.fromEntries(
    MEMORY_NUMBER_KEYS.map((key) => [key, String(policy[key])]),
  ) as Record<NumberKey, string>;
  return { ...policy, ...numbers };
}

export function parseMemoryPolicyDraft(
  draft: MemoryPolicyDraft,
): MemoryRuntimePolicy | null {
  const numbers = Object.fromEntries(
    MEMORY_NUMBER_KEYS.map((key) => [key, Number(draft[key])]),
  ) as Record<NumberKey, number>;
  if (MEMORY_NUMBER_KEYS.some((key) => !isSupportedNumber(numbers[key])))
    return null;
  return { ...draft, ...numbers };
}
