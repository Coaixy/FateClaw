import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  asRecord,
  joinList,
  pushSection,
  recordField,
  scalarText,
  textField,
} from './utils.js';

const ELEMENT_LABELS: Record<string, string> = {
  wood: '木',
  fire: '火',
  earth: '土',
  metal: '金',
  water: '水',
};

const METHOD_LABELS: Record<string, string> = {
  time: '时间起卦',
  counts: '数值起卦',
  trigrams: '指定上下卦',
};

const COUNT_METHOD_LABELS: Record<string, string> = {
  number: '报数',
  word: '字数',
  sound: '声音',
  object: '物数',
  direction: '方位',
  external: '外应',
};

const ROLE_LABELS: Record<string, string> = {
  upper: '上卦',
  lower: '下卦',
};

const RELATION_LABELS: Record<string, string> = {
  same: '体用比和',
  useGeneratesBody: '用生体',
  bodyGeneratesUse: '体生用',
  useControlsBody: '用克体',
  bodyControlsUse: '体克用',
};

function formatElement(value: unknown): string | undefined {
  const text = scalarText(value);
  if (!text) return undefined;
  return ELEMENT_LABELS[text] ?? text;
}

function formatHexagram(label: string, value: unknown): string | undefined {
  const hexagram = asRecord(value);
  if (!hexagram) return undefined;
  const name = textField(hexagram, 'fullName') ?? textField(hexagram, 'name');
  if (!name) return undefined;
  const upper = recordField(hexagram, 'upperTrigram');
  const lower = recordField(hexagram, 'lowerTrigram');
  const detail = joinList([
    upper
      ? `上${textField(upper, 'name') ?? textField(hexagram, 'upper')}`
      : undefined,
    lower
      ? `下${textField(lower, 'name') ?? textField(hexagram, 'lower')}`
      : undefined,
    textField(hexagram, 'kingWenNumber')
      ? `卦序${textField(hexagram, 'kingWenNumber')}`
      : undefined,
  ]);
  return detail ? `${label}：${name}（${detail}）` : `${label}：${name}`;
}

function formatRole(label: string, value: unknown): string | undefined {
  const role = asRecord(value);
  const trigram = role ? recordField(role, 'trigram') : undefined;
  if (!role || !trigram) return undefined;
  const trigramName = textField(trigram, 'name');
  const element = formatElement(role.element);
  const position = scalarText(role.position);
  return joinList([
    label,
    position ? (ROLE_LABELS[position] ?? position) : undefined,
    trigramName ? `${trigramName}${element ?? ''}` : undefined,
  ]);
}

function formatCalendarTime(root: Record<string, unknown>): string[] {
  const time = recordField(root, 'time');
  if (!time) return [];
  const solar = recordField(time, 'solar');
  const lunar = recordField(time, 'lunar');
  const ganzhi = recordField(time, 'ganzhi');
  const dayVoidBranches = Array.isArray(time.dayVoidBranches)
    ? time.dayVoidBranches
        .map(asRecord)
        .map((branch) => branch && textField(branch, 'name'))
        .filter((value): value is string => Boolean(value))
    : [];
  return [
    solar ? `公历：${textField(solar, 'text') ?? ''}` : undefined,
    lunar ? `农历：${textField(lunar, 'text') ?? ''}` : undefined,
    ganzhi
      ? `四柱：${['year', 'month', 'day', 'hour']
          .map((key) => recordField(ganzhi, key))
          .map((pillar) => pillar && textField(pillar, 'name'))
          .filter(Boolean)
          .join(' ')}`
      : undefined,
    dayVoidBranches.length > 0
      ? `日旬空：${dayVoidBranches.join('、')}`
      : undefined,
  ].filter((line): line is string => Boolean(line?.trim()));
}

function formatSource(root: Record<string, unknown>): Array<string | undefined> {
  const source = recordField(root, 'source');
  const numbers = source ? recordField(source, 'numbers') : undefined;
  const sourceMethod = source && textField(source, 'method');
  const label = source && textField(source, 'label');

  return [
    textField(root, 'method')
      ? `起卦方式：${METHOD_LABELS[textField(root, 'method') ?? ''] ?? textField(root, 'method')}`
      : undefined,
    sourceMethod && sourceMethod !== 'time' && sourceMethod !== 'trigram'
      ? `取数来源：${COUNT_METHOD_LABELS[sourceMethod] ?? sourceMethod}`
      : undefined,
    numbers
      ? `取数：${Object.entries(numbers)
          .flatMap(([key, value]) => {
            const text = scalarText(value);
            return text ? [`${key}=${text}`] : [];
          })
          .join('、')}`
      : undefined,
    textField(root, 'movingLine')
      ? `动爻：${textField(root, 'movingLine')}爻`
      : undefined,
    label ? `备注：${label}` : undefined,
  ];
}

/** 梅花易数 formatter：按起卦概要、五卦关系、体用与时间信息重排结果。 */
export const formatMeihuaPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root || !recordField(root, 'mainHexagram')) {
    return formatGenericPaipan(artifactData);
  }

  const relation = recordField(root, 'elementRelation');
  const lines: string[] = [];

  pushSection(lines, '起卦概要', formatSource(root));
  pushSection(lines, '卦象关系', [
    formatHexagram('本卦', recordField(root, 'mainHexagram')),
    formatHexagram('互卦', recordField(root, 'mutualHexagram')),
    formatHexagram('变卦', recordField(root, 'changedHexagram')),
    formatHexagram('错卦', recordField(root, 'oppositeHexagram')),
    formatHexagram('综卦', recordField(root, 'reversedHexagram')),
  ]);
  pushSection(lines, '体用', [
    formatRole('体卦', recordField(root, 'body')),
    formatRole('用卦', recordField(root, 'use')),
    relation && textField(relation, 'kind')
      ? `关系：${RELATION_LABELS[textField(relation, 'kind') ?? ''] ?? textField(relation, 'kind')}`
      : undefined,
  ]);
  pushSection(lines, '时间', formatCalendarTime(root));

  return lines.join('\n').trim();
};
