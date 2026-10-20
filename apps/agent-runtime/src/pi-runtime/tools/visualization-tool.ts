import {
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { VisualizationCaller } from '@fateclaw/contracts/agent/visualization';
import {
  parseVisualizationInput,
  visualizationReference,
} from '@fateclaw/contracts/visualization';

import {
  makeToolResponder,
  type PiToolRuntimeOptions,
} from './tool-execution.js';
import { toJsonOutput } from './param-utils.js';

export function createPiVisualizationTool(
  options: PiToolRuntimeOptions & { visualization: VisualizationCaller },
): ToolDefinition {
  return defineTool({
    name: 'render_visualization',
    label: 'render_visualization',
    description:
      '在当前对话中创建并保存图形。mermaid 用于流程、关系和时间线，spec 为 Mermaid 文本；vega-lite 用于数据图表，spec 为带内联 data.values 的 JSON 对象。成功后把返回的 reference 原样放入回答正文，即可在解释之间展示图形。',
    promptSnippet:
      'Use render_visualization when a diagram or data chart makes the explanation easier to understand. Embed its returned reference verbatim in the answer.',
    promptGuidelines: [
      '流程和关系图使用 mermaid；统计图使用 vega-lite。简单事实用文字即可，不必每次作图。',
      '图形内容必须来自用户提供的信息、已计算的盘面事实或明确标注的示意；不要编造统计、概率或精确的吉凶分数。summary 说明数据来源或示意性质。',
      'Mermaid 支持 flowchart、sequenceDiagram、stateDiagram-v2、mindmap、timeline；不要包含 HTML、链接、初始化指令和自定义样式。中文节点标签加引号。',
      'Vega-Lite 使用内联 data.values（总计最多 1000 行）、mark 和 encoding，支持最多 12 层 layer，以及 params 中的点选、框选、range/select/radio/checkbox 控件。transform 只支持 filter、calculate、aggregate、joinaggregate、bin、timeUnit，最多 20 步；请提前汇总需要展开的数据。筛选和计算表达式只支持字段、参数及算术比较（如 datum.count >= minimum），不支持函数调用。禁止外部 URL、图像、JavaScript、HTML 和多视图拼接。',
      '成功后在正文独立段落原样插入工具返回的 reference，前后说明读图方式和结论。不要重新输出 spec 或修改引用 ID。',
      '语法错误可简化后重新调用；服务超时或取消时用文字继续回答，不要宣称图形已成功生成。',
    ],
    parameters: Type.Object({
      type: Type.Union([Type.Literal('mermaid'), Type.Literal('vega-lite')]),
      title: Type.String({
        minLength: 1,
        maxLength: 120,
        description: '图形标题。',
      }),
      summary: Type.String({
        minLength: 1,
        maxLength: 1200,
        description: '可独立阅读的说明，交代数据来源或示意性质。',
      }),
      spec: Type.Union(
        [
          Type.String({ maxLength: 16_000 }),
          Type.Record(Type.String(), Type.Unknown()),
        ],
        { description: 'Mermaid 源码字符串，或 Vega-Lite JSON 对象。' },
      ),
    }),
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const respond = makeToolResponder({
        options,
        toolCallId,
        toolName: 'render_visualization',
        params,
        traceType: 'pi_visualization_completed',
        startedAt: Date.now(),
      });
      const finish = (fields: Record<string, unknown> & { isError: boolean }) =>
        respond({ ...fields, output: toJsonOutput(fields) });
      const parsed = parseVisualizationInput(params);
      if (!parsed.ok)
        return finish({
          isError: true,
          code: 'VISUALIZATION.INVALID_SPEC',
          error: parsed.error,
        });
      try {
        const result = await options.visualization(
          { ...parsed.value, toolCallId },
          signal,
        );
        if (!result.ok)
          return finish({
            isError: true,
            code: result.code,
            error: result.error,
          });
        return finish({
          isError: false,
          saved: true,
          id: result.artifact.id,
          title: result.artifact.title,
          summary: result.artifact.summary,
          reference: visualizationReference(result.artifact.id),
        });
      } catch {
        return finish({
          isError: true,
          code: 'VISUALIZATION.UNAVAILABLE',
          error: '图形服务暂时不可用，请用文字继续回答',
        });
      }
    },
  });
}
