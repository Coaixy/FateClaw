import {
  asRecord,
  asRecordArray,
  compactLines,
  getArray,
  getRecord,
  joinNonEmpty,
  labelValue,
  text,
} from './common.js';

const YAO_POS = ['初', '二', '三', '四', '五', '上'] as const;
const YAO_POS_FULL = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'] as const;
const LIUYAO_SKILL = 'iching-paipan';
const JINGZHAN_SKILL = 'jingzhan-paipan';
const SHENSHA_GUA_LABEL: Record<string, string> = {
  benGua: '本卦',
  zhiGua: '变卦',
  huGua: '互卦',
};

interface ParsedGuaBoard {
  root: Record<string, unknown>;
  benGua: Record<string, unknown>;
  zhiGua: Record<string, unknown>;
  huGua?: Record<string, unknown>;
  benYaoList: Array<Record<string, unknown>>;
  zhiYaoList: Array<Record<string, unknown>>;
}

type FuShenByHost = Map<number, string[]>;

function parseGuaBoard(payload: unknown, skill: string): ParsedGuaBoard {
  const root = asRecord(skill, payload, 'payload');
  const benGua = getRecord(root, 'benGua');
  const zhiGua = getRecord(root, 'zhiGua');
  if (!benGua || !zhiGua) {
    throw new Error(`[${skill}] 缺少 benGua 或 zhiGua`);
  }

  return {
    root,
    benGua,
    zhiGua,
    huGua: getRecord(root, 'huGua'),
    benYaoList: asRecordArray(
      skill,
      getArray(benGua, 'yaoList'),
      'benGua.yaoList',
    ),
    zhiYaoList: asRecordArray(
      skill,
      getArray(zhiGua, 'yaoList'),
      'zhiGua.yaoList',
    ),
  };
}

function gzLabel(value: unknown): string {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!record) return '';
  return text(record.gz) || `${text(record.tian)}${text(record.di)}`;
}

function guaLabel(gua: Record<string, unknown> | undefined): string {
  if (!gua) return '缺失';
  return joinNonEmpty(
    [
      text(gua.guaName),
      labelValue('', gua.palace) ? `${text(gua.palace)}宫` : '',
      text(gua.palaceLevel),
      text(gua.palaceWuXing) ? `${text(gua.palaceWuXing)}五行` : '',
    ],
    '/',
  );
}

function isMovingYao(
  yao: Record<string, unknown>,
  zhiYao?: Record<string, unknown>,
): boolean {
  return yao.isMoving === true || text(yao.yaoValue) !== text(zhiYao?.yaoValue);
}

function yaoPosition(yao: Record<string, unknown>): string {
  const index = Number(yao.position) - 1;
  return YAO_POS[index] ?? text(yao.position);
}

function yaoPositionFull(yao: Record<string, unknown>): string {
  const index = Number(yao.position) - 1;
  return YAO_POS_FULL[index] ?? `${text(yao.position)}爻`;
}

function formatHeader(root: Record<string, unknown>): string | null {
  const line = joinNonEmpty(
    [
      labelValue('问: ', root.question),
      labelValue('法: ', root.method),
      labelValue('爻码: ', root.yaoString),
      labelValue('动爻', root.dongYaoCount),
    ],
    ' | ',
  );
  return line || null;
}

function formatGuaTransition(board: ParsedGuaBoard): string {
  const huGua = board.huGua ? `；互${guaLabel(board.huGua)}` : '';
  return `卦: ${guaLabel(board.benGua)} -> ${guaLabel(board.zhiGua)}${huGua}`;
}

function formatYaoRows(
  board: ParsedGuaBoard,
  formatter: (
    benYao: Record<string, unknown>,
    zhiYao: Record<string, unknown> | undefined,
  ) => string,
): string[] {
  return board.benYaoList
    .map((yao, index) => formatter(yao, board.zhiYaoList[index]))
    .reverse();
}

function formatLiuyaoRows(board: ParsedGuaBoard): string[] {
  const fuShenByHost = buildFuShenByHost(board.benGua);
  return board.benYaoList
    .map((yao, index) =>
      formatLiuyaoRow(yao, board.zhiYaoList[index], fuShenByHost),
    )
    .reverse();
}

function formatGanzhiWithWuxing(yao: Record<string, unknown>): string {
  return joinNonEmpty(
    [
      `${text(yao.tianGan)}${text(yao.diZhi)}${text(yao.wuXing)}`,
      labelValue('纳音', yao.naYin),
    ],
    ' ',
  );
}

function formatLiuyaoRow(
  benYao: Record<string, unknown>,
  zhiYao: Record<string, unknown> | undefined,
  fuShenByHost: FuShenByHost,
): string {
  const ben = joinNonEmpty(
    [
      text(benYao.liuQin),
      formatGanzhiWithWuxing(benYao),
      text(benYao.liuShou) ? `(${text(benYao.liuShou)})` : '',
      text(benYao.shiYing) ? `[${text(benYao.shiYing)}]` : '',
    ],
    ' ',
  );
  const zhi = zhiYao
    ? joinNonEmpty(
        [
          text(zhiYao.liuQin),
          formatGanzhiWithWuxing(zhiYao),
          text(zhiYao.shiYing) ? `[${text(zhiYao.shiYing)}]` : '',
        ],
        ' ',
      )
    : '';
  const moving = isMovingYao(benYao, zhiYao) ? `动化 ${zhi}` : '静爻';
  // 本卦 position 是 1 基，伏神宿主索引是 0 基，这里要减 1 才能对齐。
  const fuShen =
    fuShenByHost.get(Number(benYao.position) - 1)?.join('；') ?? '';
  return joinNonEmpty(
    [`${yaoPositionFull(benYao)}: ${ben} ${moving}`, fuShen],
    ' ',
  );
}

function formatJingzhanRow(
  yao: Record<string, unknown>,
  zhiYao?: Record<string, unknown>,
): string {
  const moving = isMovingYao(yao, zhiYao) ? '动' : '静';
  const zhiValue = zhiYao ? `->${text(zhiYao.yaoValue)}` : '';
  return `${yaoPositionFull(yao)}: ${moving} ${text(yao.yaoValue)}${zhiValue}`;
}

function formatFuShenInline(
  item: Record<string, unknown>,
  label = '伏神',
): string {
  const naJia = `${text(item.fuNaJia)}${text(item.fuWuXing)}`;
  const fly = labelValue('飞', item.hostNaJia);
  const detail = joinNonEmpty(
    [text(item.fuLiuQin), naJia, fly ? `(${fly})` : ''],
    ' ',
  );
  return detail ? `${label}: ${detail}` : '';
}

function resolveFuShenHostIndex(
  item: Record<string, unknown>,
): number | null {
  const rawIndex = Number(item.hostYaoIndex);
  // 伏神位置统一按 0 基保存，摘要直接按 hostYaoIndex 归位。
  if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex > 5) return null;
  return rawIndex;
}

function buildFuShenByHost(gua: Record<string, unknown>): FuShenByHost {
  const collectRows = (key: 'fuShen' | 'pangFuShen', label: string) => {
    const rows = getArray(gua, key).map((item) =>
      asRecord(LIUYAO_SKILL, item, `${key}[]`),
    );
    return rows
      .map((item) => ({
        host: resolveFuShenHostIndex(item),
        text: formatFuShenInline(item, label),
      }))
      .filter(
        (item): item is { host: number; text: string } =>
          item.host !== null && Boolean(item.text),
      );
  };

  const fuShenRows = [
    ...collectRows('fuShen', '伏神'),
    ...collectRows('pangFuShen', '旁伏'),
  ];

  const byHost: FuShenByHost = new Map();
  for (const item of fuShenRows) {
    byHost.set(item.host, [...(byHost.get(item.host) ?? []), item.text]);
  }
  return byHost;
}

function formatGanzhi(root: Record<string, unknown>): string | null {
  const pillars = [
    root.ganZhiYear,
    root.ganZhiMonth,
    root.ganZhiDay,
    root.ganZhiHour,
  ]
    .map(gzLabel)
    .filter(Boolean);

  return pillars.length > 0 ? `干支: ${pillars.join(' ')}` : null;
}

function formatTimeMarkers(root: Record<string, unknown>): string | null {
  const markers = joinNonEmpty(
    [
      labelValue('月建', root.monthJian),
      labelValue('日空', root.dayKong),
      labelValue('时空', root.hourKong),
      labelValue('节气', root.solarTerm),
    ],
    '；',
  );
  return markers || null;
}

function formatRelatedGua(root: Record<string, unknown>): string | null {
  const zongGua = getRecord(root, 'zongGua');
  const cuoGua = getRecord(root, 'cuoGua');
  const related = joinNonEmpty(
    [
      zongGua ? `综${guaLabel(zongGua)}` : '',
      cuoGua ? `错${guaLabel(cuoGua)}` : '',
    ],
    '；',
  );
  return related || null;
}

function formatShenSha(root: Record<string, unknown>): string | null {
  const shenSha = getRecord(root, 'shenSha') ?? getRecord(root, '神煞');
  if (!shenSha) return null;
  const entries = Object.entries(shenSha)
    .map(([key, value]) => formatShenShaEntry(key, value))
    .filter(Boolean);
  return entries.length > 0 ? `神煞: ${entries.join('；')}` : null;
}

function formatShenShaEntry(name: string, value: unknown): string {
  const legacyValue = text(value);
  if (legacyValue) return `${name}-${legacyValue}`;

  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!record) return '';

  const target = getArray(record, 'targetDiZhi')
    .map(text)
    .filter(Boolean)
    .join('·');
  const matches = getArray(record, 'matches')
    .map((item) => asRecord(LIUYAO_SKILL, item, 'shenSha.matches[]'))
    .map(formatShenShaMatch)
    .filter(Boolean)
    .join('、');

  if (!target && !matches) return '';
  return `${name}-${joinNonEmpty([target, matches ? `命中${matches}` : ''], ' ')}`;
}

function formatShenShaMatch(match: Record<string, unknown>): string {
  const guaKey = text(match.guaKey);
  const guaLabel = SHENSHA_GUA_LABEL[guaKey] ?? guaKey;
  const position = Number(match.position);
  const positionLabel =
    Number.isInteger(position) && position >= 1 && position <= 6
      ? YAO_POS[position - 1]
      : text(match.position);
  const naJia = text(match.naJia) || text(match.diZhi);
  return joinNonEmpty(
    [guaLabel, positionLabel ? `${positionLabel}爻` : '', naJia],
    '',
  );
}

function formatScripture(
  gua: Record<string, unknown>,
  zhiGua: Record<string, unknown>,
): string[] {
  const rows: string[] = [];
  if (text(gua.guaCi)) rows.push(`本卦卦辞: ${text(gua.guaCi)}`);
  if (text(zhiGua.guaCi)) rows.push(`变卦卦辞: ${text(zhiGua.guaCi)}`);

  const yaoCi = getArray(gua, 'yaoCi').map(text);
  const benYaoList = asRecordArray(
    JINGZHAN_SKILL,
    getArray(gua, 'yaoList'),
    'benGua.yaoList',
  );
  const zhiYaoList = asRecordArray(
    JINGZHAN_SKILL,
    getArray(zhiGua, 'yaoList'),
    'zhiGua.yaoList',
  );
  const movingTexts = benYaoList
    .map((yao, index) => ({
      yao,
      zhiYao: zhiYaoList[index],
      yaoCi: yaoCi[index],
    }))
    .filter((item) => item.yaoCi && isMovingYao(item.yao, item.zhiYao))
    .map((item) => `${yaoPosition(item.yao)}爻: ${item.yaoCi}`);

  if (movingTexts.length > 0) rows.push(`动爻辞: ${movingTexts.join('；')}`);
  if (text(gua.tuanCi)) rows.push(`本卦象/彖: ${text(gua.tuanCi)}`);
  if (text(zhiGua.tuanCi)) rows.push(`变卦象/彖: ${text(zhiGua.tuanCi)}`);
  return rows;
}

export function formatLiuyaoBoard(payload: unknown): string {
  const board = parseGuaBoard(payload, LIUYAO_SKILL);
  const lines = compactLines([
    '【六爻排盘 AI摘要】',
    '#基础',
    formatHeader(board.root),
    formatGanzhi(board.root),
    formatTimeMarkers(board.root),
    formatShenSha(board.root),
    '#卦象',
    formatGuaTransition(board),
    '#六爻',
    ...formatLiuyaoRows(board),
  ]);

  return lines.join('\n');
}

export function formatJingzhanBoard(payload: unknown): string {
  const board = parseGuaBoard(payload, JINGZHAN_SKILL);
  const lines = compactLines([
    '【经占排盘 AI摘要】',
    '#基础',
    formatHeader(board.root),
    '#卦象',
    formatGuaTransition(board),
    formatRelatedGua(board.root),
    '#爻象',
    ...formatYaoRows(board, formatJingzhanRow),
    text(board.root.explanation)
      ? `取断规则: ${text(board.root.explanation)}`
      : '',
    ...formatScripture(board.benGua, board.zhiGua),
  ]);

  return lines.join('\n');
}
