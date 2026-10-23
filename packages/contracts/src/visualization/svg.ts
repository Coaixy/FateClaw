import { parseXml, XmlElement, XmlError, XmlText } from '@rgrove/parse-xml';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export interface SvgDiagramNode {
  tag: string;
  attributes: Record<string, string>;
  children: Array<SvgDiagramNode | string>;
}

const common = [
  'id',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'vector-effect',
  'marker-start',
  'marker-mid',
  'marker-end',
  'clip-path',
];
const attributesByTag: Record<string, string[]> = {
  svg: ['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio'],
  g: [],
  defs: [],
  title: [],
  desc: [],
  path: ['d', 'pathLength'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
  tspan: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
  marker: [
    'viewBox',
    'markerWidth',
    'markerHeight',
    'refX',
    'refY',
    'orient',
    'markerUnits',
  ],
  linearGradient: [
    'x1',
    'y1',
    'x2',
    'y2',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
  ],
  radialGradient: [
    'cx',
    'cy',
    'r',
    'fx',
    'fy',
    'fr',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
  ],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  clipPath: ['clipPathUnits'],
};
const colorAttributes = new Set(['fill', 'stroke', 'color', 'stop-color']);
const referenceAttributes = new Set([
  'marker-start',
  'marker-mid',
  'marker-end',
  'clip-path',
]);
const color =
  /^(?:[a-zA-Z]{1,24}|#[a-f\d]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%+\-\s]+\)|var\(--color-(?:ink|muted|muted-soft|primary|hairline|surface-soft|surface-card|success|warning|error)\))$/i;
const localReference = /^url\(#([a-zA-Z][\w-]{0,63})\)$/;

/** Parse an inert SVG tree; never pass model-provided markup to an HTML parser. */
export function parseSvgDiagram(
  spec: unknown,
): { ok: true; root: SvgDiagramNode } | { ok: false; error: string } {
  if (
    typeof spec !== 'string' ||
    !spec.trim() ||
    new TextEncoder().encode(spec).length > 64_000
  )
    return { ok: false, error: 'SVG spec 必须是最多 64000 字节的 SVG 字符串' };

  let count = 0;
  let validationError = '';
  const ids = new Map<string, string>();
  const references: Array<{ id: string; attribute: string }> = [];
  const reject = (error: string): never => {
    validationError = error;
    throw new Error(error);
  };
  const visit = (tag: XmlElement, depth: number): SvgDiagramNode => {
    if (++count > 500 || depth >= 16)
      reject('SVG 最多 500 个元素、16 层嵌套，请简化图解');
    if (!Object.hasOwn(attributesByTag, tag.name))
      reject('SVG 只支持基础图形、文字、分组、箭头、渐变和裁剪');
    if (
      (depth === 0 && tag.name !== 'svg') ||
      (depth > 0 && tag.name === 'svg')
    )
      reject('SVG 必须有且只有一个 svg 根元素，不支持嵌套 svg');

    const node: SvgDiagramNode = {
      tag: tag.name,
      attributes: {},
      children: [],
    };
    const allowed = new Set([...common, ...attributesByTag[tag.name]]);
    for (const [name, value] of Object.entries(tag.attributes)) {
      if (!allowed.has(name))
        reject(
          'SVG 属性不受支持；使用绘图属性，不要包含 style、事件、链接或外部资源',
        );
      if (name === 'xmlns') {
        if (depth > 0 || value !== SVG_NAMESPACE) reject('SVG 命名空间无效');
        continue;
      }
      if (value.length > 16_000) reject('SVG 单个属性过长，请简化路径');
      if (name === 'id') {
        if (!/^[a-zA-Z][\w-]{0,63}$/.test(value) || ids.has(value))
          reject('SVG id 必须是唯一的字母开头标识符，最多 64 字符');
        ids.set(value, tag.name);
      }
      if (colorAttributes.has(name) || referenceAttributes.has(name)) {
        const reference = value.match(localReference);
        if (reference && name !== 'color' && name !== 'stop-color')
          references.push({ id: reference[1], attribute: name });
        else if (
          referenceAttributes.has(name) ? value !== 'none' : !color.test(value)
        )
          reject('SVG 颜色使用颜色值或主题变量；引用只能是本图内的 url(#id)');
      } else if (
        name !== 'id' &&
        /[\\<>]|url\s*\(|(?:https?|data|javascript|file):/i.test(value)
      ) {
        reject('SVG 不支持链接、外部资源或可执行内容');
      }
      if (name === 'viewBox') {
        const dimensions = value
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        if (
          dimensions.length !== 4 ||
          dimensions.some(
            (part) => !Number.isFinite(part) || Math.abs(part) > 10_000,
          ) ||
          dimensions[2] <= 0 ||
          dimensions[3] <= 0
        )
          reject('SVG viewBox 必须包含四个有限数字，宽高必须大于零');
        if (
          depth === 0 &&
          (dimensions[2] < 100 ||
            dimensions[2] > 1600 ||
            dimensions[3] < 100 ||
            dimensions[3] > 2400)
        )
          reject('SVG 画布宽度为 100–1600，高度为 100–2400');
      }
      node.attributes[name] = value;
    }
    if (depth === 0 && !node.attributes.viewBox)
      reject('SVG 根元素必须提供 viewBox，例如 0 0 480 420');
    for (const child of tag.children) {
      if (child instanceof XmlElement)
        node.children.push(visit(child, depth + 1));
      else if (child instanceof XmlText) {
        if (['text', 'tspan', 'title', 'desc'].includes(node.tag))
          node.children.push(child.text);
        else if (child.text.trim())
          reject('SVG 文字必须放在 text、tspan、title 或 desc 中');
      } else reject('SVG 不支持处理指令或外部样式表');
    }
    return node;
  };
  try {
    const document = parseXml(spec, { preserveDocumentType: true });
    if (document.children.some((node) => node.type !== 'element'))
      reject('SVG 不支持 DOCTYPE、自定义实体或处理指令');
    if (!document.root) reject('SVG 缺少根元素');
    const root = visit(document.root!, 0);
    for (const reference of references) {
      const target = ids.get(reference.id);
      const expected =
        reference.attribute === 'clip-path'
          ? ['clipPath']
          : reference.attribute.startsWith('marker-')
            ? ['marker']
            : ['linearGradient', 'radialGradient'];
      if (!target || !expected.includes(target))
        reject('SVG 引用必须指向本图内匹配的箭头、渐变或裁剪定义');
    }
    return { ok: true, root };
  } catch (error) {
    if (
      !validationError &&
      !(error instanceof XmlError) &&
      !(error instanceof RangeError)
    )
      throw error;
    return {
      ok: false,
      error:
        validationError || 'SVG XML 语法无效，请检查标签闭合、实体和属性引号',
    };
  }
}
