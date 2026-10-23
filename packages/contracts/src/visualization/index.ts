import { parseSvgDiagram } from './svg.js';
export { parseSvgDiagram, SVG_NAMESPACE, type SvgDiagramNode } from './svg.js';

export const VISUALIZATION_VERSION = 1;
export const MAX_VISUALIZATION_BYTES = 64_000;
export const VISUALIZATION_ID = /^visualization-[a-f0-9]{64}$/;

export type VisualizationInput = {
  title: string;
  summary: string;
} & (
  | { type: 'mermaid'; spec: string }
  | { type: 'svg'; spec: string }
  | { type: 'vega-lite'; spec: Record<string, unknown> }
);

export type VisualizationArtifact = VisualizationInput & {
  version: typeof VISUALIZATION_VERSION;
  id: string;
};

export type VisualizationValidation =
  | { ok: true; value: VisualizationInput }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The same bounded, offline-only contract guards persistence and historical rendering. */
export function parseVisualizationInput(
  value: unknown,
): VisualizationValidation {
  if (!isRecord(value)) return { ok: false, error: '图形参数必须是对象' };
  const { title, summary, type, spec } = value;
  if (typeof title !== 'string' || !title.trim() || title.length > 120)
    return { ok: false, error: 'title 必须是 1–120 字的标题' };
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 1200)
    return {
      ok: false,
      error: 'summary 必须是 1–1200 字的文字说明，交代数据来源或示意性质',
    };
  if (type === 'mermaid') {
    if (typeof spec !== 'string' || !spec.trim() || spec.length > 16_000)
      return { ok: false, error: 'Mermaid spec 必须是 1–16000 字的图形描述' };
    if (
      !/^(?:flowchart|graph|sequenceDiagram|stateDiagram-v2|mindmap|timeline)\b/.test(
        spec.trim(),
      ) ||
      /%%\{|^\s*(?:---|click|style|classDef)\b|<\/?[a-z!]|(?:https?|javascript|data|file):/im.test(
        spec,
      )
    )
      return {
        ok: false,
        error:
          '使用 flowchart、sequenceDiagram、stateDiagram-v2、mindmap 或 timeline；不要包含 HTML、链接或自定义配置和样式',
      };
    return {
      ok: true,
      value: {
        type,
        title: title.trim(),
        summary: summary.trim(),
        spec: spec.trim(),
      },
    };
  }
  if (type === 'svg') {
    const result = parseSvgDiagram(spec);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        type,
        title: title.trim(),
        summary: summary.trim(),
        spec: (spec as string).trim(),
      },
    };
  }
  if (type !== 'vega-lite' || !isRecord(spec))
    return {
      ok: false,
      error:
        'type 必须为 svg、mermaid 或 vega-lite；前两者使用字符串，vega-lite 使用 JSON 对象',
    };

  let nodes = 0;
  let rows = 0;
  let views = 0;
  let error = '';
  const forbidden = new Set([
    'url',
    'href',
    'element',
    'on',
    '__proto__',
    'constructor',
    'prototype',
    'datasets',
    'repeat',
    'facet',
    'hconcat',
    'vconcat',
  ]);
  const marks = new Set([
    'bar',
    'line',
    'area',
    'point',
    'circle',
    'square',
    'tick',
    'rule',
    'text',
    'rect',
    'arc',
    'trail',
    'boxplot',
    'errorbar',
    'errorband',
  ]);
  function visit(item: unknown, depth: number, data = false): void {
    if (error) return;
    if (++nodes > 12_000 || depth > 24) {
      error = '图表结构过大或嵌套过深，请简化';
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string' && item.length <= 16_000) {
      if (/url\s*\(|(?:javascript|data|file):/i.test(item))
        error = '图表不支持外部资源和可执行链接';
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > 2000) error = '图表数组过长，请汇总数据';
      else for (const child of item) visit(child, depth + 1, data);
      return;
    }
    if (!isRecord(item)) {
      error = '图表只能包含有限的 JSON 值';
      return;
    }
    if (data) {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          error = '数据字段不能包含对象原型属性';
          return;
        }
        visit(child, depth + 1, true);
      }
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) {
        error = `首版图表不支持 ${key}；请使用内联数据和声明式字段映射`;
        return;
      }
      if (key === 'data') {
        if (
          !isRecord(child) ||
          !Array.isArray(child.values) ||
          Object.keys(child).some((field) => field !== 'values')
        ) {
          error = 'data 只支持内联 values 数组';
          return;
        }
        rows += child.values.length;
        if (rows > 1000) {
          error = '内联数据总计最多 1000 行，请先汇总';
          return;
        }
      }
      if (key === 'mark') {
        const mark = isRecord(child) ? child.type : child;
        if (typeof mark !== 'string' || !marks.has(mark) || ++views > 12) {
          error = '使用常规统计图形，最多 12 个图层';
          return;
        }
      }
      if (key === 'transform') {
        if (
          !Array.isArray(child) ||
          child.length > 20 ||
          child.some(
            (transform) =>
              !isRecord(transform) ||
              ![
                'filter',
                'calculate',
                'aggregate',
                'joinaggregate',
                'bin',
                'timeUnit',
              ].some((kind) => kind in transform),
          )
        ) {
          error =
            'transform 仅支持筛选、计算、聚合、分箱和时间单位，最多 20 步；请先汇总需要展开的数据';
          return;
        }
      }
      if (key === 'bind' && child !== 'scales' && child !== 'legend') {
        if (
          !isRecord(child) ||
          !['range', 'select', 'radio', 'checkbox'].includes(
            String(child.input),
          )
        ) {
          error = '交互控件仅支持 range、select、radio、checkbox 或 scales';
          return;
        }
      }
      if (
        (key === 'expr' ||
          key === 'calculate' ||
          key === 'filter' ||
          key === 'test' ||
          key === 'toggle') &&
        typeof child === 'string' &&
        (/[\w$\])\]]\s*\(/.test(child) ||
          /\b(?:constructor|prototype|__proto__|window|document|globalThis)\b/.test(
            child,
          ))
      ) {
        error =
          '表达式只支持字段、参数和算术比较，不支持函数调用或访问运行环境';
        return;
      }
      if (
        (key === 'width' || key === 'height') &&
        child !== 'container' &&
        (typeof child !== 'number' || child < 50 || child > 1200)
      ) {
        error = '图表宽高必须为 50–1200 的数字或 container';
        return;
      }
      if (
        (key === 'tickCount' || key === 'maxbins') &&
        typeof child === 'number' &&
        (child < 1 || child > 1000)
      ) {
        error = '坐标刻度和分箱数量必须在 1–1000 之间';
        return;
      }
      visit(child, depth + 1, key === 'data');
    }
  }
  visit(spec, 0);
  if (error) return { ok: false, error };
  if (views === 0)
    return { ok: false, error: '图表需要 mark 或包含 mark 的 layer' };
  if (
    new TextEncoder().encode(JSON.stringify(spec)).length >
    MAX_VISUALIZATION_BYTES
  )
    return { ok: false, error: '图表描述最多 64000 字节，请减少数据或图层' };
  return {
    ok: true,
    value: { type, title: title.trim(), summary: summary.trim(), spec },
  };
}

export function parseVisualizationArtifact(
  value: unknown,
): VisualizationArtifact | null {
  if (
    !isRecord(value) ||
    value.version !== VISUALIZATION_VERSION ||
    typeof value.id !== 'string' ||
    !VISUALIZATION_ID.test(value.id)
  )
    return null;
  const result = parseVisualizationInput(value);
  return result.ok
    ? { ...result.value, version: VISUALIZATION_VERSION, id: value.id }
    : null;
}

export function visualizationReference(id: string): string {
  return `\`\`\`visualization\n${id}\n\`\`\``;
}

/** Match dedicated fenced blocks, respecting outer fences used in code examples. */
function visualizationBlocks(
  content: string,
): Array<{ id: string; start: number; end: number }> {
  const blocks: Array<{ id: string; start: number; end: number }> = [];
  let offset = 0;
  let fence: {
    marker: string;
    length: number;
    visualization: boolean;
    body: string[];
    start: number;
  } | null = null;
  const finish = () => {
    if (fence?.visualization) {
      const id = fence.body.join('\n').trim();
      if (VISUALIZATION_ID.test(id))
        blocks.push({ id, start: fence.start, end: offset });
    }
    fence = null;
  };
  for (const raw of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const start = offset;
    offset += raw.length;
    const line = raw.replace(/\r?\n$/, '');
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[\t ]*$/);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      )
        finish();
      else fence.body.push(line);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
    if (opening)
      fence = {
        marker: opening[1][0],
        length: opening[1].length,
        visualization: opening[2].trim() === 'visualization',
        body: [],
        start,
      };
  }
  finish();
  return blocks;
}

export function visualizationReferences(content: string): string[] {
  return visualizationBlocks(content).map((block) => block.id);
}

export function replaceVisualizationReferences(
  content: string,
  describe: (id: string) => string,
): string {
  let output = '';
  let offset = 0;
  for (const block of visualizationBlocks(content)) {
    output += content.slice(offset, block.start) + describe(block.id) + '\n';
    offset = block.end;
  }
  return output + content.slice(offset);
}
