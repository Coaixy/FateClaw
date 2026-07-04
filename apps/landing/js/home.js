/* ============================================================
   小奕想要三合木 · 主页交互「黑金朱砂」版
   只被 index.html 引用。
   包含:导航滚动态、移动端菜单、入场动效、夜空星点 + 流星画布、
        面板聚光灯追踪、罗盘视差倾斜。
   原则:滚动相关状态交给 IntersectionObserver,连续动画只改
        transform / CSS 变量,全部尊重 prefers-reduced-motion。
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- 开场动画:河图 → 洛书 → 揭幕 ----------
     0ms      河图五十五点按「中五 → 一六 → 二七 → 三八 → 四九」次第亮起
     1500ms   河图旋出,洛书九宫成形,金环爆开,站名浮现
     2750ms   幕布拉开,解除 intro-hold,首屏内容重新入场
     点击任意处可跳过;reduced-motion 下整段免除。 */
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** 生成一排等距坐标(横向 axis='x' 或纵向 axis='y'),fixed 为另一轴的定值 */
  function dotRow(n, center, step, axis, fixed) {
    var pts = [];
    var start = center - ((n - 1) * step) / 2;
    for (var i = 0; i < n; i++) {
      pts.push(axis === 'x' ? [start + i * step, fixed] : [fixed, start + i * step]);
    }
    return pts;
  }

  /** 往 svg 里画一组点(带连线),delay 为该组首点的出场延迟,返回组内最后延迟 */
  function drawGroup(svg, pts, yang, delay, gap, withLink) {
    if (withLink && pts.length > 1) {
      var ln = document.createElementNS(SVG_NS, 'line');
      ln.setAttribute('x1', pts[0][0]); ln.setAttribute('y1', pts[0][1]);
      ln.setAttribute('x2', pts[pts.length - 1][0]); ln.setAttribute('y2', pts[pts.length - 1][1]);
      ln.setAttribute('class', 'link');
      ln.style.animationDelay = (delay + pts.length * gap) + 'ms';
      svg.appendChild(ln);
    }
    pts.forEach(function (p, i) {
      var c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]); c.setAttribute('r', 5);
      c.setAttribute('class', 'dot ' + (yang ? 'yang' : 'yin'));
      c.style.animationDelay = (delay + i * gap) + 'ms';
      svg.appendChild(c);
    });
    return delay + pts.length * gap;
  }

  /** 河图:中五(十)居中,一六北、二七南、三八东、四九金西,阳金实点阴朱空心 */
  function buildHetu(svg) {
    var t = 0;
    // 中央:天五(十字五点)与地十(上下两排各五)
    t = drawGroup(svg, [[160, 160], [160, 142], [160, 178], [142, 160], [178, 160]], true, t, 40, false);
    t = drawGroup(svg, dotRow(5, 160, 22, 'x', 114), false, t, 20, true);
    t = drawGroup(svg, dotRow(5, 160, 22, 'x', 206), false, t, 20, true);
    // 北(下):天一生水,地六成之
    t = drawGroup(svg, [[160, 244]], true, t, 30, false);
    t = drawGroup(svg, dotRow(6, 160, 22, 'x', 282), false, t, 18, true);
    // 南(上):地二生火,天七成之
    t = drawGroup(svg, dotRow(2, 160, 24, 'x', 76), false, t, 20, true);
    t = drawGroup(svg, dotRow(7, 160, 22, 'x', 38), true, t, 18, true);
    // 东(左):天三生木,地八成之
    t = drawGroup(svg, dotRow(3, 160, 22, 'y', 76), true, t, 20, true);
    t = drawGroup(svg, dotRow(8, 160, 22, 'y', 38), false, t, 18, true);
    // 西(右):地四生金,天九成之
    t = drawGroup(svg, dotRow(4, 160, 22, 'y', 244), false, t, 20, true);
    t = drawGroup(svg, dotRow(9, 160, 22, 'y', 282), true, t, 18, true);
    return t; // 约 1150ms 全部点亮
  }

  /** 洛书:三阶幻方,戴九履一、左三右七、二四为肩、六八为足、五居中央 */
  function buildLuoshu(svg) {
    // 九宫淡格线,与首屏罗盘同一血脉
    var grid = document.createElementNS(SVG_NS, 'path');
    grid.setAttribute('d', 'M46 46 H274 V274 H46 Z M122 46 V274 M198 46 V274 M46 122 H274 M46 198 H274');
    grid.setAttribute('class', 'grid-line');
    svg.appendChild(grid);
    // 每格一个数字点簇:offsets 为相对格心的点位
    var S = 15;
    var clusters = [
      { n: 1, cx: 160, cy: 236, pts: [[0, 0]] },
      { n: 2, cx: 236, cy: 84, pts: [[-S, 0], [S, 0]] },
      { n: 3, cx: 84, cy: 160, pts: [[0, -S - 3], [0, 0], [0, S + 3]] },
      { n: 4, cx: 84, cy: 84, pts: [[-S, -S], [S, -S], [-S, S], [S, S]] },
      { n: 5, cx: 160, cy: 160, pts: [[0, 0], [0, -S - 3], [0, S + 3], [-S - 3, 0], [S + 3, 0]] },
      { n: 6, cx: 236, cy: 236, pts: [[-S, -S - 3], [S, -S - 3], [-S, 0], [S, 0], [-S, S + 3], [S, S + 3]] },
      { n: 7, cx: 236, cy: 160, pts: [[-S - 3, -S], [0, -S], [S + 3, -S], [0, 0], [-S - 3, S], [0, S], [S + 3, S]] },
      { n: 8, cx: 84, cy: 236, pts: [[-9, -25], [9, -25], [-9, -8], [9, -8], [-9, 8], [9, 8], [-9, 25], [9, 25]] },
      { n: 9, cx: 160, cy: 84, pts: [[-S - 1, -S - 1], [0, -S - 1], [S + 1, -S - 1], [-S - 1, 0], [0, 0], [S + 1, 0], [-S - 1, S + 1], [0, S + 1], [S + 1, S + 1]] }
    ];
    clusters.forEach(function (cl, idx) {
      var pts = cl.pts.map(function (o) { return [cl.cx + o[0], cl.cy + o[1]]; });
      drawGroup(svg, pts, cl.n % 2 === 1, idx * 65, 18, false); // 按一到九次第成形
    });
  }

  var intro = document.getElementById('intro');
  if (intro) {
    if (reduceMotion) {
      intro.remove();
      document.body.classList.remove('intro-hold');
    } else {
      // 开场即回顶:避免浏览器恢复上次滚动位置,揭幕后落在半山腰
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      buildHetu(document.getElementById('introHetu'));
      buildLuoshu(document.getElementById('introLuoshu'));
      var introDone = false;
      var captionEl = document.getElementById('introCaption');
      var tPhase2 = setTimeout(function () {
        intro.classList.add('phase2');
        captionEl.textContent = '洛书';
      }, 1500);
      var tOpen = setTimeout(openIntro, 2750);

      intro.addEventListener('click', openIntro);
    }
  }

  /** 拉开幕布并收尾:跳过与正常结束共用同一出口 */
  function openIntro() {
    if (introDone) return;
    introDone = true;
    clearTimeout(tPhase2);
    clearTimeout(tOpen);
    // 浏览器的滚动位置恢复可能晚于载入时的回顶,揭幕前再断言一次
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    intro.classList.add('phase2'); // 提前跳过时补上洛书态,避免空心开幕
    intro.classList.add('open');
    document.body.classList.remove('intro-hold');
    // 重启首屏入场:先摘掉 .in 强制回到隐藏态,回流后再挂回,
    // 让标题/按钮/罗盘的登场动画恰好发生在幕布拉开的瞬间
    var top = document.getElementById('top');
    if (top && top.classList.contains('in')) {
      top.classList.remove('in');
      void top.offsetWidth;
      top.classList.add('in');
    }
    setTimeout(function () { intro.remove(); }, 1000);
  }

  /* ---------- 导航:滚过顶部哨兵后落下墨色底 ---------- */
  var nav = document.getElementById('nav');
  var sentinel = document.getElementById('nav-sentinel');
  if (nav && sentinel && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      nav.classList.toggle('scrolled', !entries[0].isIntersecting);
    }).observe(sentinel);
  }

  /* ---------- 移动端菜单开合 ---------- */
  var toggle = document.getElementById('menuToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    // 点击任意导航项后收起菜单,避免锚点跳转后菜单仍挡住内容
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        links.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- 分屏切换:进入视口的屏加 .in(子元素登场),离开移除(退场) ----------
     同时驱动右侧圆点页码的 active 态。 */
  var sections = document.querySelectorAll('.snap-section');
  var dots = document.querySelectorAll('.dots a');
  if ('IntersectionObserver' in window) {
    var secIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        entry.target.classList.toggle('in', entry.isIntersecting);
        if (entry.isIntersecting && entry.target.id) {
          var hash = '#' + entry.target.id;
          dots.forEach(function (d) {
            d.classList.toggle('active', d.getAttribute('href') === hash);
          });
        }
      });
    }, { threshold: 0.35 });
    sections.forEach(function (s) { secIo.observe(s); });
  } else {
    sections.forEach(function (s) { s.classList.add('in'); });
  }

  /* ---------- 面板聚光灯:把指针位置写进 CSS 变量 ----------
     CSS 里的 radial-gradient 以 --mx/--my 为圆心,鎏金光斑跟随光标。 */
  if (finePointer) {
    document.querySelectorAll('.panel, .consult-card').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        el.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
  }

  /* ---------- 罗盘视差倾斜:光标在 hero 内移动时罗盘轻微转动 ----------
     目标角度由指针位置决定,rAF 里做缓动插值,只改 transform。 */
  var hero = document.querySelector('.hero');
  var compass = document.querySelector('.hero-compass svg');
  if (!reduceMotion && finePointer && hero && compass) {
    var targetX = 0, targetY = 0, curX = 0, curY = 0, tilting = false;

    function tiltLoop() {
      // 缓动系数 0.08:跟手但带一点惯性
      curX += (targetX - curX) * 0.08;
      curY += (targetY - curY) * 0.08;
      compass.style.transform = 'rotateX(' + curX.toFixed(2) + 'deg) rotateY(' + curY.toFixed(2) + 'deg)';
      // 接近目标后停表,避免空转
      if (Math.abs(targetX - curX) > 0.01 || Math.abs(targetY - curY) > 0.01) {
        requestAnimationFrame(tiltLoop);
      } else {
        tilting = false;
      }
    }
    function kick() {
      if (!tilting) { tilting = true; requestAnimationFrame(tiltLoop); }
    }
    hero.addEventListener('pointermove', function (e) {
      var nx = e.clientX / window.innerWidth - 0.5;   // -0.5 ~ 0.5
      var ny = e.clientY / window.innerHeight - 0.5;
      targetY = nx * 10;                              // 左右摆头
      targetX = ny * -8;                              // 上下俯仰
      kick();
    });
    hero.addEventListener('pointerleave', function () {
      targetX = 0; targetY = 0; kick();
    });
  }

  /* ---------- 夜空画布:星点呼吸 + 偶发流星 ----------
     星点一次生成,rAF 里做明暗呼吸;流星按随机间隔划过。
     reduced-motion 下只静态绘制一帧,不启动动画循环。 */
  var canvas = document.getElementById('sky');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var stars = [];
  var meteors = [];
  var meteorCountdown = 200;      // 距下一颗流星的帧数
  var rafId = null;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    draw(0);
  }

  // 星点数量随视口面积走,上限压低保证移动端流畅;约一成是鎏金星
  function seed() {
    var count = Math.min(130, Math.floor(window.innerWidth * window.innerHeight / 13000));
    stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        r: Math.random() * 1.5 + 0.4,
        base: Math.random() * 0.4 + 0.22,    // 基础亮度(比旧版更亮)
        phase: Math.random() * Math.PI * 2,  // 呼吸相位
        speed: Math.random() * 0.5 + 0.2,    // 呼吸速度
        gold: Math.random() < 0.12           // 少量鎏金色星点
      });
    }
  }

  // 从视口上缘随机位置生成一颗流星,斜向左下划过
  function spawnMeteor() {
    var speed = Math.random() * 5 + 7;
    var angle = Math.PI * (0.72 + Math.random() * 0.1);   // 约 130°~148° 方向
    meteors.push({
      x: window.innerWidth * (0.3 + Math.random() * 0.7),
      y: Math.random() * window.innerHeight * 0.25,
      vx: Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed * -1,
      life: 0,
      max: 46 + Math.random() * 24
    });
  }

  function draw(t) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    // 星点
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var alpha = s.base + Math.sin(t * 0.001 * s.speed + s.phase) * 0.16;
      alpha = Math.max(alpha, 0.06);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.gold
        ? 'rgba(233, 185, 111, ' + alpha.toFixed(3) + ')'
        : 'rgba(240, 233, 219, ' + alpha.toFixed(3) + ')';
      ctx.fill();
    }

    // 流星:头亮尾淡的渐变线段,生命周期内先亮后灭
    for (var m = meteors.length - 1; m >= 0; m--) {
      var mt = meteors[m];
      mt.x += mt.vx;
      mt.y += mt.vy;
      mt.life++;
      if (mt.life > mt.max || mt.x < -120 || mt.y > window.innerHeight + 120) {
        meteors.splice(m, 1);
        continue;
      }
      // 亮度包络:前 20% 渐入,之后线性渐出
      var p = mt.life / mt.max;
      var glow = p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8;
      var tailX = mt.x - mt.vx * 9;
      var tailY = mt.y - mt.vy * 9;
      var grad = ctx.createLinearGradient(mt.x, mt.y, tailX, tailY);
      grad.addColorStop(0, 'rgba(240, 233, 219, ' + (0.85 * glow).toFixed(3) + ')');
      grad.addColorStop(0.3, 'rgba(233, 185, 111, ' + (0.4 * glow).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(233, 185, 111, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(mt.x, mt.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    }
  }

  function loop(t) {
    // 流星计时:归零后生成,再随机下一次间隔(约 3~8 秒)
    if (--meteorCountdown <= 0) {
      spawnMeteor();
      meteorCountdown = 180 + Math.floor(Math.random() * 300);
    }
    draw(t);
    rafId = requestAnimationFrame(loop);
  }

  resize();
  window.addEventListener('resize', resize);

  if (!reduceMotion) {
    rafId = requestAnimationFrame(loop);
    // 页面不可见时暂停动画,省电
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
      } else if (!rafId) {
        rafId = requestAnimationFrame(loop);
      }
    });
  }
})();
