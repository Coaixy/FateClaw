'use client';

/** 五行。 */
export type WuXing = 'wood' | 'fire' | 'earth' | 'metal' | 'water';

/** 天干 → 五行。 */
const STEM_WUXING: Record<string, WuXing> = {
  甲: 'wood',
  乙: 'wood',
  丙: 'fire',
  丁: 'fire',
  戊: 'earth',
  己: 'earth',
  庚: 'metal',
  辛: 'metal',
  壬: 'water',
  癸: 'water',
};

/** 地支 → 五行（取地支本气，展示用途足够，不展开藏干）。 */
const BRANCH_WUXING: Record<string, WuXing> = {
  子: 'water',
  丑: 'earth',
  寅: 'wood',
  卯: 'wood',
  辰: 'earth',
  巳: 'fire',
  午: 'fire',
  未: 'earth',
  申: 'metal',
  酉: 'metal',
  戌: 'earth',
  亥: 'water',
};

/** 五行 → 文字色 class（复用项目内置的五行图表配色 token）。 */
export const WUXING_TEXT_CLASS: Record<WuXing, string> = {
  wood: 'text-chart-wood',
  fire: 'text-chart-fire',
  earth: 'text-chart-earth',
  metal: 'text-chart-metal',
  water: 'text-chart-water',
};

/** 五行中文名。 */
export const WUXING_LABEL: Record<WuXing, string> = {
  wood: '木',
  fire: '火',
  earth: '土',
  metal: '金',
  water: '水',
};

/** 单字 → 五行（先查天干再查地支，查不到返回 null）。 */
export function charWuXing(ch: string): WuXing | null {
  return STEM_WUXING[ch] ?? BRANCH_WUXING[ch] ?? null;
}

/**
 * 八字四柱排盘展示：每柱天干在上、地支在下竖排，逐字按五行上色。
 *
 * @param bazi 空格分隔的四柱，如 "甲子 己巳 壬寅 甲辰"。
 * @param size md（列表卡片）/ lg（详情大图）。
 */
export function BaziPillars({
  bazi,
  size = 'md',
}: {
  bazi: string;
  size?: 'md' | 'lg';
}) {
  const pillars = bazi.trim().split(/\s+/).filter(Boolean);
  const charCls = size === 'lg' ? 'text-3xl' : 'text-lg';
  const gapCls = size === 'lg' ? 'gap-3' : 'gap-2';
  return (
    <div className={`flex ${gapCls}`}>
      {pillars.map((pillar, pi) => (
        <div key={pi} className="flex flex-col items-center gap-0.5">
          {[...pillar].map((ch, ci) => {
            const wx = charWuXing(ch);
            return (
              <span
                key={ci}
                className={`font-semibold leading-tight ${charCls} ${
                  wx ? WUXING_TEXT_CLASS[wx] : 'text-ink'
                }`}
              >
                {ch}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** 五行配色图例。 */
export function WuXingLegend() {
  const order: WuXing[] = ['wood', 'fire', 'earth', 'metal', 'water'];
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
      <span>五行配色</span>
      {order.map((wx) => (
        <span
          key={wx}
          className={`font-semibold ${WUXING_TEXT_CLASS[wx]}`}
        >
          {WUXING_LABEL[wx]}
        </span>
      ))}
    </div>
  );
}
