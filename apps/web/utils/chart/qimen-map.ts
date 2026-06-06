// 洛书九宫顺序（上南下北，左东右西）。
// grid 位置 → 卦名：
//   0:巽/4  1:离/9  2:坤/2
//   3:震/3  4:中/5  5:兑/7
//   6:艮/8  7:坎/1  8:乾/6
export const LUOSHU_ORDER: Array<string> = [
  '巽', '离', '坤',
  '震', '中', '兑',
  '艮', '坎', '乾',
];

export const GUA_TO_GONG_NUMBER: Record<string, number> = {
  坎: 1,
  坤: 2,
  震: 3,
  巽: 4,
  中: 5,
  乾: 6,
  兑: 7,
  艮: 8,
  离: 9,
};

// 八门 / 九星 / 八神 各自的五行归属（用于着色）
export const MEN_WUXING: Record<string, '金' | '木' | '水' | '火' | '土'> = {
  休: '水',
  生: '土',
  伤: '木',
  杜: '木',
  景: '火',
  死: '土',
  惊: '金',
  开: '金',
};

export const STAR_WUXING: Record<string, '金' | '木' | '水' | '火' | '土'> = {
  蓬: '水',
  任: '土',
  冲: '木',
  辅: '木',
  英: '火',
  芮: '土',
  柱: '金',
  心: '金',
  禽: '土',
};

export const SHEN_COLOR: Record<string, string> = {
  符: 'text-amber-300',      // 值符
  蛇: 'text-emerald-400',    // 腾蛇
  阴: 'text-sky-300',        // 太阴
  合: 'text-emerald-300',    // 六合
  勾: 'text-yellow-600',     // 勾陈
  雀: 'text-rose-400',       // 朱雀
  虎: 'text-rose-400',       // 白虎
  地: 'text-yellow-600',     // 九地
  天: 'text-amber-200',      // 九天
  玄: 'text-slate-400',      // 玄武
};

const WUXING_TEXT_COLOR: Record<string, string> = {
  金: 'text-yellow-400',
  木: 'text-emerald-400',
  水: 'text-blue-400',
  火: 'text-rose-400',
  土: 'text-amber-700',
};

export function wuxingColor(wuxing?: string): string {
  if (!wuxing) return 'text-ink';
  return WUXING_TEXT_COLOR[wuxing] ?? 'text-ink';
}

// 后天八卦宫对应的地支（用于马星/空亡判断）
export const GUA_TO_BRANCHES: Record<string, string[]> = {
  坎: ['子'],
  坤: ['未', '申'],
  震: ['卯'],
  巽: ['辰', '巳'],
  中: [],
  乾: ['戌', '亥'],
  兑: ['酉'],
  艮: ['丑', '寅'],
  离: ['午'],
};

// 天干五行归属（用于宫位内天干着色）
export const STEM_WUXING_MAP: Record<string, '金' | '木' | '水' | '火' | '土'> = {
  甲: '木', 乙: '木',
  丙: '火', 丁: '火',
  戊: '土', 己: '土',
  庚: '金', 辛: '金',
  壬: '水', 癸: '水',
};

export function stemWuxing(stem?: string): string {
  if (!stem) return '';
  const wx = STEM_WUXING_MAP[stem];
  return wx ? wuxingColor(wx) : 'text-ink';
}

// 甲遁六仪：甲子→戊、甲戌→己、甲申→庚、甲午→辛、甲辰→壬、甲寅→癸
export const JIA_LIUYI_MAP: Record<string, string> = {
  甲子: '戊', 甲戌: '己', 甲申: '庚',
  甲午: '辛', 甲辰: '壬', 甲寅: '癸',
};

// 八神名字规范化（fateclaw 单字 → 原版两字）
export const SHEN_FULL_NAME: Record<string, string> = {
  符: '值符', 蛇: '腾蛇', 阴: '太阴', 合: '六合',
  勾: '勾陈', 雀: '朱雀',
  虎: '白虎', 地: '九地', 天: '九天', 玄: '玄武',
};

// 九星名字规范化：fateclaw 单字 "蓬" → "天蓬"
export function fullStarName(s?: string): string {
  if (!s) return '';
  if (s === '芮禽') return s;
  if (s.startsWith('天')) return s;
  return `天${s}`;
}
