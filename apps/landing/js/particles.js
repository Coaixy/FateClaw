// ================================================================
// Canvas - 天干地支与八卦飘字
// ================================================================
(function () {
  const canvas = document.getElementById('particles');
  if (!canvas) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let W, H;

  /**
   * 同步画布尺寸，避免固定宽高导致符号在高分辨率屏幕上被裁切。
   * @returns {void}
   */
  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  const TIANGAN = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  const DIZHI   = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
  const BAGUA   = ['☰','☱','☲','☳','☴','☵','☶','☷'];
  const ALL_SYMBOLS = [
    ...TIANGAN.map(char => ({ char, kind: 'tiangan' })),
    ...DIZHI.map(char => ({ char, kind: 'dizhi' })),
    ...BAGUA.map(char => ({ char, kind: 'bagua' })),
  ];

  // 每个字符生成多个漂浮实例，总数约 46 个
  // 天干 × 2, 地支 × 1, 八卦 × 1 = 40，再补 6 个随机远景符号
  const instances = [];

  /**
   * 创建一个背景漂浮符号，按类别分配尺寸、速度和基础透明度。
   * @param {string} char 要绘制的汉字或八卦符号。
   * @param {string} kind 符号类别，用于区分天干、地支和八卦。
   * @returns {{char: string, kind: string, x: number, y: number, vx: number, vy: number, size: number, base: number, phase: number, freq: number}} 可被动画循环消费的符号状态。
   */
  function makeChar(char, kind) {
    const isTian = kind === 'tiangan';
    const isBagua = kind === 'bagua';

    return {
      char,
      kind,
      x: Math.random() * W,
      y: Math.random() * H,
      // 非常缓慢的随机飘动方向
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.18 - 0.06, // 略微向上
      size: isBagua
        ? 22 + Math.random() * 18   // 八卦 22-40px，作为背景符号更稳重
        : isTian
          ? 18 + Math.random() * 16 // 天干 18-34px，稍大
          : 14 + Math.random() * 14, // 地支 14-28px
      // 基础透明度较低，营造虚实感
      base: isBagua ? 0.035 + Math.random() * 0.11 : 0.06 + Math.random() * 0.18,
      phase: Math.random() * Math.PI * 2,
      freq:  isBagua ? 0.08 + Math.random() * 0.18 : 0.12 + Math.random() * 0.28,
    };
  }

  TIANGAN.forEach(c => { instances.push(makeChar(c, 'tiangan')); instances.push(makeChar(c, 'tiangan')); });
  DIZHI.forEach(c =>   { instances.push(makeChar(c, 'dizhi')); });
  BAGUA.forEach(c =>   { instances.push(makeChar(c, 'bagua')); });
  // 再补几个大符号作为远景点缀，让天干地支与八卦的比例更自然
  for (let i = 0; i < 6; i++) {
    const symbol = ALL_SYMBOLS[Math.floor(Math.random() * ALL_SYMBOLS.length)];
    const inst = makeChar(symbol.char, symbol.kind);
    inst.size = 32 + Math.random() * 24;  // 32-56px 大字
    inst.base = 0.04 + Math.random() * 0.08;
    instances.push(inst);
  }

  let last = 0;

  /**
   * 绘制一帧背景符号动画，所有运动只影响 canvas 内部像素。
   * @param {number} now requestAnimationFrame 传入的时间戳。
   * @returns {void}
   */
  function frame(now) {
    last = now;
    const t = now / 1000;

    ctx.clearRect(0, 0, W, H);

    for (const c of instances) {
      // 移动
      c.x += c.vx;
      c.y += c.vy;

      // 越界重置到对面随机位置
      const pad = c.size * 2;
      if (c.x < -pad)  { c.x = W + pad * 0.5; c.y = Math.random() * H; }
      if (c.x > W + pad) { c.x = -pad * 0.5;  c.y = Math.random() * H; }
      if (c.y < -pad)  { c.y = H + pad * 0.5; c.x = Math.random() * W; }
      if (c.y > H + pad) { c.y = -pad * 0.5;  c.x = Math.random() * W; }

      // 呼吸透明度
      const alpha = Math.max(0.02, c.base + Math.sin(t * c.freq + c.phase) * c.base * 0.8);

      // 天干：暖金色  地支：金铜色  八卦：青绿色，区分术数层次但保持低调
      const color = c.kind === 'tiangan'
        ? `hsla(44, 82%, 72%, ${alpha})`
        : c.kind === 'bagua'
          ? `hsla(172, 58%, 66%, ${alpha})`
          : `hsla(36, 70%, 62%, ${alpha})`;

      ctx.globalAlpha = 1;
      ctx.font = `${c.size}px 'Noto Serif SC', serif`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.char, c.x, c.y);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
