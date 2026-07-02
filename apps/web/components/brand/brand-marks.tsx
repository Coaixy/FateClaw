/**
 * 品牌图形组件:宣纸朱砂主题的两件核心图形资产。
 * - BaguaRing:先天八卦环形线描,用作页面仪式感背景装饰
 * - BrandSeal:「守义」二字白文方印,品牌标识
 * 纯展示组件,颜色跟随 currentColor / token,无状态无副作用。
 */

/** 先天八卦卦符,自正上方起顺时针:乾、巽、坎、艮、坤、震、离、兑(伏羲先天方位)。 */
const TRIGRAMS = ['☰', '☴', '☵', '☶', '☷', '☳', '☲', '☱'] as const;

/**
 * 先天八卦环:两圈同心细线之间环布八个卦符,卦符朝向圆心(罗盘式)。
 * 颜色随 currentColor,调用方用 text-* 与 opacity-* 控制强度。
 *
 * @param props.className 尺寸/定位/颜色/透明度由调用方传入。
 */
export function BaguaRing({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 360 360" className={className} aria-hidden="true">
      <circle cx="180" cy="180" r="150" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="180" cy="180" r="112" fill="none" stroke="currentColor" strokeWidth="1" />
      {TRIGRAMS.map((glyph, index) => (
        <text
          key={glyph}
          x="180"
          y="62"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="30"
          fill="currentColor"
          transform={`rotate(${index * 45} 180 180)`}
        >
          {glyph}
        </text>
      ))}
    </svg>
  );
}

/**
 * 品牌方印:印章红底上的白色太极图形(阴阳双鱼),保留篆印式的方形红底。
 *
 * @param props.className 尺寸与阴影由调用方传入(如 "h-12 w-12 shadow-sm")。
 */
export function BrandSeal({ className }: { className?: string }) {
  return (
    <div
      className={`flex items-center justify-center rounded-lg bg-seal ${className ?? ''}`}
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%] text-white" aria-hidden="true">
        {/* 太极:外圈 + S 形分界(用上下两个半圆偏移表达) + 阴阳双点 */}
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.9" />
        <path d="M12 2 A10 10 0 0 1 12 22 A5 5 0 0 1 12 12 A5 5 0 0 0 12 2" fill="currentColor" opacity="0.85" />
        <circle cx="12" cy="7" r="1.6" fill="currentColor" />
        <circle cx="12" cy="17" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </div>
  );
}
