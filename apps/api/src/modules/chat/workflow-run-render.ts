/**
 * 工作流运行的纯渲染逻辑(无 IO,便于单测)。
 *
 * - renderWorkflowPrompt:把 AI 步 prompt 里的 {{input.<key>}} / {{step.<stepId>.output}} 替换为实际值。
 * - collectStepOutputs:从会话消息里按 id 约定收集各步最新产出。
 */

/** 引用占位符:{{ input.xxx }} 或 {{ step.<stepId>.output }}。 */
const REF_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * 渲染 AI 步 prompt。
 *
 * @param template prompt 模板。
 * @param context input 为本次运行输入;stepOutputs 为各步最新产出(stepId→文本)。
 * @returns 渲染后的 prompt;未知引用渲染为空串(避免把 {{}} 原样发给模型)。
 */
export function renderWorkflowPrompt(
  template: string,
  context: {
    input: Record<string, string>;
    stepOutputs: Record<string, string>;
  },
): string {
  return template.replace(REF_PATTERN, (_whole, rawRef: string) => {
    const ref = rawRef.trim();
    if (ref.startsWith('input.')) {
      return context.input[ref.slice('input.'.length)] ?? '';
    }
    const stepMatch = /^step\.([A-Za-z0-9_]+)\.output$/.exec(ref);
    if (stepMatch) {
      return context.stepOutputs[stepMatch[1]] ?? '';
    }
    return '';
  });
}

/**
 * 从会话消息里收集各 AI 步的最新产出(stepId → 回复文本)。
 *
 * @remarks 回复消息 id 形如 `wf-<stepId>-<ts>-<rand>_reply`;stepId 不含 '-'(路由已限定),
 *          故按首个 '-' 切出。同一步多次运行/重跑时按时间戳取最新,从而拿到卦师润色后的版本。
 */
export function collectStepOutputs(
  messages: { id: string; content: string; timestamp: string }[],
): Record<string, string> {
  const latestByStep = new Map<
    string,
    { content: string; timestamp: string }
  >();
  for (const message of messages) {
    if (!message.id.startsWith('wf-') || !message.id.endsWith('_reply')) {
      continue;
    }
    const rest = message.id.slice('wf-'.length);
    const dashIndex = rest.indexOf('-');
    if (dashIndex <= 0) continue;
    const stepId = rest.slice(0, dashIndex);
    const prev = latestByStep.get(stepId);
    if (!prev || message.timestamp >= prev.timestamp) {
      latestByStep.set(stepId, {
        content: message.content,
        timestamp: message.timestamp,
      });
    }
  }
  const result: Record<string, string> = {};
  for (const [stepId, value] of latestByStep) {
    result[stepId] = value.content;
  }
  return result;
}
