import type { ToolDefinition, ToolExecutionMode } from '../types.js';

export const PI_INTERPRET_TOOL_NAME = 'prepare_xuanxue_interpretation';

const PI_INTERPRET_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: PI_INTERPRET_TOOL_NAME,
    description:
      '玄学解读准备工具。校验盘面来源、规范化权威盘面内容、规划用户知识库材料；不生成最终解读，最终回复由 Pi 调用 final_reply 完成。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            '可选。仅在运行时无法从本轮 artifact、activeBoardContext 或历史 toolContext 自动取得盘面时使用。',
        },
        question: {
          type: 'string',
          description: '用户的具体问题（可选）',
        },
        category: {
          type: 'string',
          description: "术数类别提示，如 '八字'、'奇门'、'紫微' 等（可选）",
        },
        extra_context: {
          type: 'string',
          description: '额外的解读参考资料（通常由运行时自动注入）',
        },
        analysis_mode: {
          type: 'string',
          enum: ['full', 'followup_delta'],
          description:
            "Pi 对本轮任务的判断：'full' = 完整解读；'followup_delta' = 用户正在追问上一轮解读，只做增量分析。",
        },
        content_source: {
          type: 'string',
          enum: ['skill', 'user'],
          description:
            "content 的来源：'skill' = 系统排盘产出；'user' = 仅限专用 user_pasted_board 协议入口。Pi runtime 可能在执行前改写为内部来源。",
        },
      },
      required: [],
    },
  },
};

export function isPiInterpretToolName(name: string): boolean {
  return name === PI_INTERPRET_TOOL_NAME;
}

export function getPiInterpretToolDefinition(): ToolDefinition {
  return PI_INTERPRET_TOOL_DEFINITION;
}

export function getPiInterpretToolExecutionMode(
  name: string,
): ToolExecutionMode | undefined {
  return isPiInterpretToolName(name) ? 'serial' : undefined;
}
