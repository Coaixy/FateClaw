import type { ToolDefinition, ToolExecutionMode } from '../types.js';

export const PI_INTERPRET_TOOL_NAME = 'interpret_xuanxue';

const PI_INTERPRET_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: PI_INTERPRET_TOOL_NAME,
    description:
      '玄学专业解读分析。用于解读系统排盘、用户自贴盘面、当前选中盘面或历史盘面追问。',
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
        content_source: {
          type: 'string',
          enum: ['skill', 'user'],
          description:
            "content 的来源：'skill' = 系统排盘产出；'user' = 仅限专用 user_pasted_board 协议入口。",
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

