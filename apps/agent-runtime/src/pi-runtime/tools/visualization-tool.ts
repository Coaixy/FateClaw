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
      '为回答主动绘制并保存解释性图解，让图形穿插在正文中。svg 用于五行生克环、环形结构、标注示意、对比和时间轴，spec 为 SVG 字符串；mermaid 用于自动布局的流程与关系图，spec 为 Mermaid 文本；vega-lite 用于真实数据的统计图表，spec 为内联数据 JSON。成功后把返回的 reference 原样放入正文对应位置。',
    promptSnippet:
      'Proactively illustrate relationships, structures, processes, comparisons and timelines with render_visualization. Choose SVG for custom explanatory diagrams, Mermaid for automatic layouts, and Vega-Lite for data charts. Place each returned reference next to the explanation it supports.',
    promptGuidelines: [
      '回答需要解释多个要素之间的关系、空间结构、变化过程、时间顺序或方案差异时，应主动使用 render_visualization 辅助理解，不要等用户明确要求“画图”。例如五行生克用环形箭头，十神关系用分组连线，大运流年用时间轴，判断过程用步骤图。用户要求纯文字、简单事实或简短追问时可直接文字回答。',
      '先明确图要帮助用户看懂哪一个问题，再选择图形。每张图聚焦一个主题，长解读可在不同解释段落之间放置不同图解；不要把所有图堆在文末，也不要把整段文字搬进图框。图前引出问题，图后说明关键关系或结论。',
      '没有可信数值也可以绘制定性关系、结构和时间顺序示意。自由布局、圆环、箭头、高亮、文字标注用 svg；常规自动布局的流程和关系图用 mermaid；有明确数值来源的分布和趋势用 vega-lite。不要为了凑统计图把定性判断转换成分数。',
      '图形内容必须来自用户提供的信息、已计算的盘面事实或明确标注的示意；不要编造统计、概率或精确的吉凶分数。summary 说明数据来源或示意性质。',
      'SVG spec 是完整 <svg viewBox="0 0 480 420">...</svg>。支持 g、path、rect、circle、ellipse、line、polyline、polygon、text/tspan、title/desc，以及 defs 中的 marker、linearGradient、radialGradient、stop、clipPath；箭头和渐变通过本图唯一 id 与 url(#id) 引用。只使用这些标签和绘图属性，不要包含 style、class、脚本、事件、HTML、图片、链接、use 或动画。XML 中 & 写成 &amp;，标签必须闭合。最多 500 个元素、16 层、64000 字节。',
      'SVG 建议画布宽 480、高度按内容延展，主要文字字号 24–28，辅助标注至少 20，节点之间留足空间、连线避开文字；内容多时优先纵向展开，保持手机可读。画布宽度允许 100–1600，高度 100–2400；使用 viewBox，不要靠固定像素宽度适配屏幕。文字用 fill="var(--color-ink)"，次要文字用 var(--color-muted)，重点用 var(--color-primary)，背景用 var(--color-surface-soft)，节点边框用 var(--color-hairline)，关系连线用 var(--color-muted) 或 var(--color-primary)，以适应明暗主题。',
      'SVG 示例：<svg viewBox="0 0 480 180"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z" fill="var(--color-primary)"/></marker></defs><circle cx="100" cy="90" r="42" fill="var(--color-surface-soft)" stroke="var(--color-primary)"/><path d="M150 90H320" stroke="var(--color-primary)" stroke-width="2" marker-end="url(#arrow)"/><text x="100" y="98" text-anchor="middle" font-size="24" fill="var(--color-ink)">木</text><text x="235" y="68" text-anchor="middle" font-size="20" fill="var(--color-muted)">相生</text><text x="365" y="98" text-anchor="middle" font-size="24" fill="var(--color-ink)">火</text></svg>。这是关系示意，不能作为用户盘面事实。',
      'Mermaid 支持 flowchart、sequenceDiagram、stateDiagram-v2、mindmap、timeline；不要包含 HTML、链接、初始化指令和自定义样式。中文节点标签加引号。',
      'Vega-Lite 使用内联 data.values（总计最多 1000 行）、mark 和 encoding，支持最多 12 层 layer，以及 params 中的点选、框选、range/select/radio/checkbox 控件。transform 只支持 filter、calculate、aggregate、joinaggregate、bin、timeUnit，最多 20 步；请提前汇总需要展开的数据。筛选和计算表达式只支持字段、参数及算术比较（如 datum.count >= minimum），不支持函数调用。禁止外部 URL、图像、JavaScript、HTML 和多视图拼接。',
      '成功后在正文独立段落原样插入工具返回的 reference，前后说明读图方式和结论。不要重新输出 spec 或修改引用 ID。',
      '语法错误可简化后重新调用；服务超时或取消时用文字继续回答，不要宣称图形已成功生成。',
    ],
    parameters: Type.Object({
      type: Type.Union([
        Type.Literal('svg'),
        Type.Literal('mermaid'),
        Type.Literal('vega-lite'),
      ]),
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
          Type.String({ maxLength: 64_000 }),
          Type.Record(Type.String(), Type.Unknown()),
        ],
        { description: 'SVG 或 Mermaid 源码字符串，或 Vega-Lite JSON 对象。' },
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
