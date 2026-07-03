// ================================================================
// 多语言
// ================================================================
(function () {
const i18n = {
  'zh-CN': {
    pageTitle: '小奕想要三合木',
    nav: { logoCn: '命枢', systems: '术数入门', architecture: '命与运', faq: 'FAQs', about: '关于' },
    hero: {
      headline: '东方玄学智能体',
      subEn: 'The Eastern Metaphysics Agent',
      subCn: '排盘、解读与追问，一次说清楚',
      description: 'FateClaw 把传统术数变成可交互的智能解读体验：先排盘，再结合你的问题给出清晰建议。',
      cta1: '马上体验',
    },
    agent: {
      title: '把玄学解读做成真正能用的助手',
      subtitle: 'FateClaw 先把盘排准，再结合你的问题与资料，把复杂术数转成清晰、可追问的答案。',
      chartLabel: '排得准',
      chartTitle: '先把盘面算清楚',
      chartDesc: '八字、紫微、奇门、六爻等先由确定规则排盘，基础信息更稳。',
      contextLabel: '更懂你',
      contextTitle: '不止给通用答案',
      contextDesc: '可以结合你的资料、偏好和历史问题，让解读更贴近真实处境。',
      readingLabel: '讲得清',
      readingTitle: '复杂术数变成白话建议',
      readingDesc: '把关键依据、提醒和可选行动说清楚，看完还能继续追问。',
      advantage1Title: '更省心',
      advantage1Desc: '不用自己切换术数、整理规则，直接从问题进入解读。',
      advantage2Title: '更可靠',
      advantage2Desc: '先有盘面，再谈解释，避免凭空给出玄而又玄的判断。',
      advantage3Title: '更能追问',
      advantage3Desc: '一次解读之后，还能继续聊选择、时机、风险和下一步。',
    },
    systems: {
      title: '术数不是同一套工具',
      subtitle: '奇门、八字、紫微、六爻和梅花易数各自回答不同层级的问题。先分清方法，解读才有边界。',
      qimenLabel: '奇门遁甲',
      qimenTitle: '时空格局与取用',
      qimenDesc: '以时间、方位、九宫和门星神组合成局，适合看情势、取势和行动窗口。',
      baziLabel: '八字',
      baziTitle: '命局结构与阶段节律',
      baziDesc: '以出生年月日时组成四柱，看五行、十神和大运流年之间的长期结构。',
      ziweiLabel: '紫微斗数',
      ziweiTitle: '宫位、星曜与人生议题',
      ziweiDesc: '以十二宫与星曜组合观察人生主题，擅长把命局拆成关系、事业、财帛等场景。',
      liuyaoLabel: '六爻',
      liuyaoTitle: '一事一占的变化判断',
      liuyaoDesc: '从六个爻位、动变、世应和用神入手，围绕一个具体问题判断过程与结果。',
      meihuaLabel: '梅花易数',
      meihuaTitle: '象、数、时机的快速取象',
      meihuaDesc: '重视当下触发的象与数，用更轻量的方式把事件转成卦象和判断线索。',
      readMore: '查看入门',
    },
    arch: {
      title: '命、运与选择怎么分工',
      subtitle: '命像车，运像路。FateClaw 先看车的结构，再看路况、时机和岔路，把占卜与选择放在可行动的位置。',
      destinyLabel: '命',
      destinyTitle: '命是车：结构与承载',
      destinyDesc: '命更像车的底盘、发动机和载重上限，描述一个人先天结构、惯性、优势和容易消耗的地方。',
      destinyProsTitle: '看什么',
      destinyPros: '看底层配置、性格结构、长期倾向与阶段节律，适合回答“我这辆车适合怎么开”。',
      destinyConsTitle: '边界',
      destinyCons: '车的结构不是全部结果，同一辆车在不同路况、速度和选择下，会走出很不一样的体验。',
      divinationLabel: '运',
      divinationTitle: '运是路：路况与岔口',
      divinationDesc: '运更像正在走的路，包含外部环境、阶段机会、阻力、时机和那些需要当下判断的岔口。',
      divinationProsTitle: '占卜看路',
      divinationPros: '占卜把问题收束到当前路口，帮助判断路况、时机、风险和不同路线的机会成本。',
      divinationConsTitle: '选择改路',
      divinationCons: '选择不会凭空换一辆车，但会影响何时出发、在哪变道、避开什么坑，以及把车开到哪条路上。',
      choiceTitle: '占卜不是改命，是帮助选路',
      choiceDesc: '命盘给出车的结构，占卜给出此刻路口的信号。真正改变“运”的，往往是看清路况之后做出的选择、节奏和行动。',
    },
    faq: {
      title: 'FAQs',
      subtitle: '把常见边界讲清楚：FateClaw 做排盘和辅助解读，不把玄学包装成绝对结论。',
      q1: 'FateClaw 是算命工具还是 AI 聊天？',
      a1: '它先用确定性引擎完成排盘，再让 LLM 结合 Tool、Skill 和用户问题进行解读。AI 不是凭空编盘，而是围绕结构化材料工作。',
      q2: '占卜和命理可以一起用吗？',
      a2: '可以。命理提供长期背景，占卜处理当下问题。组合使用时需要明确各自回答什么，避免把短期卦象当成长期命盘。',
      q3: 'LLM 会不会胡编结论？',
      a3: 'FateClaw 的方向是让排盘、工具调用和 Skill 来源可追溯，降低模型自由发挥的空间。但解读仍是辅助参考，不是绝对事实。',
      q4: 'Skill 在这里是什么？',
      a4: 'Skill 是创作者沉淀的流派规则、案例经验和解释边界。LLM 在需要时读取授权 Skill，让解读更接近特定体系。',
      q5: '结果能直接用于现实决策吗？',
      a5: '不建议。结果适合作为自我观察、问题拆解和备选视角，不能替代法律、医疗、财务、投资等专业建议。',
      q6: '目前支持哪些术数？',
      a6: '当前页面展示的核心方向包括奇门遁甲、八字、紫微斗数、六爻和梅花易数，后续能力以实际产品开放为准。',
    },
    about: {
      intro: '这里是小奕的个人主页。FateClaw（命枢）是我目前主打的作品：一个东方玄学智能体。',
    },
    footer: { logoCn: '命枢', copy: '© 2026 小奕 · Coaixy', icp: '浙ICP备2024132053号' },
  },

  'zh-TW': {
    pageTitle: '小奕想要三合木',
    nav: { logoCn: '命樞', systems: '術數入門', architecture: '命與運', faq: 'FAQs', about: '關於' },
    hero: {
      headline: '東方玄學智能體',
      subEn: 'The Eastern Metaphysics Agent',
      subCn: '排盤、解讀與追問，一次說清楚',
      description: 'FateClaw 把傳統術數變成可互動的智能解讀體驗：先排盤，再結合你的問題給出清晰建議。',
      cta1: '馬上體驗',
    },
    agent: {
      title: '把玄學解讀做成真正能用的助手',
      subtitle: 'FateClaw 先把盤排準，再結合你的問題與資料，把複雜術數轉成清晰、可追問的答案。',
      chartLabel: '排得準',
      chartTitle: '先把盤面算清楚',
      chartDesc: '八字、紫微、奇門、六爻等先由確定規則排盤，基礎資訊更穩。',
      contextLabel: '更懂你',
      contextTitle: '不止給通用答案',
      contextDesc: '可以結合你的資料、偏好和歷史問題，讓解讀更貼近真實處境。',
      readingLabel: '講得清',
      readingTitle: '複雜術數變成白話建議',
      readingDesc: '把關鍵依據、提醒和可選行動說清楚，看完還能繼續追問。',
      advantage1Title: '更省心',
      advantage1Desc: '不用自己切換術數、整理規則，直接從問題進入解讀。',
      advantage2Title: '更可靠',
      advantage2Desc: '先有盤面，再談解釋，避免憑空給出玄而又玄的判斷。',
      advantage3Title: '更能追問',
      advantage3Desc: '一次解讀之後，還能繼續聊選擇、時機、風險和下一步。',
    },
    systems: {
      title: '術數不是同一套工具',
      subtitle: '奇門、八字、紫微、六爻和梅花易數各自回答不同層級的問題。先分清方法，解讀才有邊界。',
      qimenLabel: '奇門遁甲',
      qimenTitle: '時空格局與取用',
      qimenDesc: '以時間、方位、九宮和門星神組合成局，適合看情勢、取勢和行動窗口。',
      baziLabel: '八字',
      baziTitle: '命局結構與階段節律',
      baziDesc: '以出生年月日時組成四柱，看五行、十神和大運流年之間的長期結構。',
      ziweiLabel: '紫微斗數',
      ziweiTitle: '宮位、星曜與人生議題',
      ziweiDesc: '以十二宮與星曜組合觀察人生主題，擅長把命局拆成關係、事業、財帛等場景。',
      liuyaoLabel: '六爻',
      liuyaoTitle: '一事一占的變化判斷',
      liuyaoDesc: '從六個爻位、動變、世應和用神入手，圍繞一個具體問題判斷過程與結果。',
      meihuaLabel: '梅花易數',
      meihuaTitle: '象、數、時機的快速取象',
      meihuaDesc: '重視當下觸發的象與數，用更輕量的方式把事件轉成卦象和判斷線索。',
      readMore: '查看入門',
    },
    arch: {
      title: '命、運與選擇怎麼分工',
      subtitle: '命像車，運像路。FateClaw 先看車的結構，再看路況、時機和岔路，把占卜與選擇放在可行動的位置。',
      destinyLabel: '命',
      destinyTitle: '命是車：結構與承載',
      destinyDesc: '命更像車的底盤、引擎和載重上限，描述一個人先天結構、慣性、優勢和容易消耗的地方。',
      destinyProsTitle: '看什麼',
      destinyPros: '看底層配置、性格結構、長期傾向與階段節律，適合回答「我這輛車適合怎麼開」。',
      destinyConsTitle: '邊界',
      destinyCons: '車的結構不是全部結果，同一輛車在不同路況、速度和選擇下，會走出很不一樣的體驗。',
      divinationLabel: '運',
      divinationTitle: '運是路：路況與岔口',
      divinationDesc: '運更像正在走的路，包含外部環境、階段機會、阻力、時機和那些需要當下判斷的岔口。',
      divinationProsTitle: '占卜看路',
      divinationPros: '占卜把問題收束到當前路口，幫助判斷路況、時機、風險和不同路線的機會成本。',
      divinationConsTitle: '選擇改路',
      divinationCons: '選擇不會憑空換一輛車，但會影響何時出發、在哪變道、避開什麼坑，以及把車開到哪條路上。',
      choiceTitle: '占卜不是改命，是幫助選路',
      choiceDesc: '命盤給出車的結構，占卜給出此刻路口的信號。真正改變「運」的，往往是看清路況之後做出的選擇、節奏和行動。',
    },
    faq: {
      title: 'FAQs',
      subtitle: '把常見邊界講清楚：FateClaw 做排盤和輔助解讀，不把玄學包裝成絕對結論。',
      q1: 'FateClaw 是算命工具還是 AI 聊天？',
      a1: '它先用確定性引擎完成排盤，再讓 LLM 結合 Tool、Skill 和用戶問題進行解讀。AI 不是憑空編盤，而是圍繞結構化材料工作。',
      q2: '占卜和命理可以一起用嗎？',
      a2: '可以。命理提供長期背景，占卜處理當下問題。組合使用時需要明確各自回答什麼，避免把短期卦象當成長期命盤。',
      q3: 'LLM 會不會胡編結論？',
      a3: 'FateClaw 的方向是讓排盤、工具呼叫和 Skill 來源可追溯，降低模型自由發揮的空間。但解讀仍是輔助參考，不是絕對事實。',
      q4: 'Skill 在這裡是什麼？',
      a4: 'Skill 是創作者沉澱的流派規則、案例經驗和解釋邊界。LLM 在需要時讀取授權 Skill，讓解讀更接近特定體系。',
      q5: '結果能直接用於現實決策嗎？',
      a5: '不建議。結果適合作為自我觀察、問題拆解和備選視角，不能替代法律、醫療、財務、投資等專業建議。',
      q6: '目前支援哪些術數？',
      a6: '當前頁面展示的核心方向包括奇門遁甲、八字、紫微斗數、六爻和梅花易數，後續能力以實際產品開放為準。',
    },
    about: {
      intro: '這裡是小奕的個人主頁。FateClaw（命樞）是我目前主打的作品：一個東方玄學智能體。',
    },
    footer: { logoCn: '命樞', copy: '© 2026 小奕 · Coaixy', icp: '浙ICP备2024132053号' },
  },

  'en': {
    pageTitle: 'FateClaw | Eastern Divination AI',
    nav: { logoCn: '', systems: 'Methods', architecture: 'Fate & Timing', faq: 'FAQs', about: 'About' },
    hero: {
      headline: 'Eastern Divination, Made Interactive',
      subEn: 'Ask a real question. Get a chart-backed reading.',
      subCn: 'BaZi, Zi Wei, Qi Men, Liu Yao, and Mei Hua in one experience',
      description: 'FateClaw turns classical Chinese systems into clear guidance for love, career, timing, and personal direction.',
      cta1: 'Start a Reading',
    },
    agent: {
      title: 'From ancient charts to answers you can use',
      subtitle: 'Start with what is on your mind. FateClaw picks the right lens, explains the signals, and lets you keep digging.',
      chartLabel: 'Step 01',
      chartTitle: 'Ask in plain English',
      chartDesc: 'No need to know BaZi or Qi Men first. Start with a question about work, love, timing, or direction.',
      contextLabel: 'Step 02',
      contextTitle: 'Match the right method',
      contextDesc: 'Different questions need different systems. FateClaw helps choose the lens before giving a reading.',
      readingLabel: 'Step 03',
      readingTitle: 'Get a reading you can actually use',
      readingDesc: 'The answer explains key signals, likely pressure points, and possible next moves in plain language.',
      advantage1Title: 'No terminology wall',
      advantage1Desc: 'You can explore classical Chinese systems without studying years of jargon first.',
      advantage2Title: 'Not a random horoscope',
      advantage2Desc: 'The reading starts from a structured chart, then explains what matters for your question.',
      advantage3Title: 'Built for follow-up',
      advantage3Desc: 'Keep asking about timing, alternatives, tradeoffs, and what to watch next.',
    },
    systems: {
      title: 'Five classic systems, one readable experience',
      subtitle: 'Each method answers a different kind of question. FateClaw helps people pick the right lens without memorizing the terminology.',
      qimenLabel: 'Qi Men',
      qimenTitle: 'Strategy, timing, direction',
      qimenDesc: 'For decisions that depend on when to act, where to move, and how the situation is shifting.',
      baziLabel: 'BaZi',
      baziTitle: 'Personality, patterns, life timing',
      baziDesc: 'Uses your birth time to map long-term tendencies, strengths, pressure points, and life phases.',
      ziweiLabel: 'Zi Wei',
      ziweiTitle: 'A life map by domains',
      ziweiDesc: 'Breaks life into relationships, career, wealth, family, travel, and other concrete areas.',
      liuyaoLabel: 'Liu Yao',
      liuyaoTitle: 'One question, practical signal',
      liuyaoDesc: 'For specific questions with a near-term outcome, from relationships and offers to lost items and decisions.',
      meihuaLabel: 'Mei Hua',
      meihuaTitle: 'Quick omen from the moment',
      meihuaDesc: 'Turns a number, time, direction, sound, or event trigger into a compact reading.',
      readMore: 'Explore method',
    },
    arch: {
      title: 'Know the pattern. Choose the move.',
      subtitle: 'FateClaw treats destiny analysis as context and divination as timing. The point is not blind belief. The point is a better frame for decisions.',
      destinyLabel: 'Pattern',
      destinyTitle: 'What stays with you',
      destinyDesc: 'Long-term charts reveal tendencies, strengths, recurring pressure points, and the seasons when certain themes become louder.',
      destinyProsTitle: 'Good for',
      destinyPros: 'Self-understanding, life phases, relationship patterns, career style, and the kinds of situations that repeat.',
      destinyConsTitle: 'Boundary',
      destinyCons: 'A chart is not a prison. Environment, timing, and choices still shape what happens next.',
      divinationLabel: 'Moment',
      divinationTitle: 'What is changing now',
      divinationDesc: 'Divination narrows the focus to a current question, helping compare timing, risks, options, and signals in motion.',
      divinationProsTitle: 'Good for',
      divinationPros: 'Specific questions, near-term decisions, timing windows, negotiation dynamics, and what to watch next.',
      divinationConsTitle: 'Choice still matters',
      divinationCons: 'A reading can highlight the road conditions, but the route still depends on what you do with the information.',
      choiceTitle: 'The reading is not a verdict',
      choiceDesc: 'Use it as a map of signals, pressure, and timing. The best outcome is not certainty. It is clearer choice.',
    },
    faq: {
      title: 'FAQs',
      subtitle: 'Clear boundaries matter: FateClaw helps you explore patterns and timing. It does not sell absolute certainty.',
      q1: 'Is FateClaw fortune telling or an AI chat?',
      a1: 'It is neither a random horoscope nor a blank chatbot. FateClaw creates structured charts first, then turns them into readable guidance around your question.',
      q2: 'Can divination and destiny analysis be used together?',
      a2: 'Yes. Destiny analysis gives the long-term pattern, while divination focuses on the current question. Keeping that difference clear makes the reading more useful.',
      q3: 'Can the reading be wrong?',
      a3: 'Yes. Treat it as reflective guidance, not a guaranteed prediction. Its value is in framing the situation, surfacing signals, and helping you ask better questions.',
      q4: 'Do I need to understand BaZi or Qi Men first?',
      a4: 'No. The page explains each method in plain language, and the product direction is to let people start from real questions rather than terminology.',
      q5: 'Can I use results for real-world decisions?',
      a5: 'Use them as one perspective, not as professional advice. Legal, medical, financial, investment, and other high-stakes decisions still need qualified experts.',
      q6: 'Which systems are supported?',
      a6: 'The site introduces Qi Men, BaZi, Zi Wei, Liu Yao, and Mei Hua. Actual product availability follows the live release.',
    },
    about: {
      intro: "This is the personal homepage of Coaixy (Xiao Yi). FateClaw is my current main project: an Eastern metaphysics agent.",
    },
    footer: { logoCn: '', copy: '© 2026 Coaixy · 小奕', icp: '' },
  },
};

const SUPPORTED_LANGS = ['zh-CN', 'zh-TW', 'en'];

/**
 * 标准化语言代码，确保浏览器和缓存里的输入只映射到页面已有文案。
 * @param {string | null | undefined} lang 浏览器或本地缓存中的语言代码。
 * @returns {string | null} 可用语言代码；无法识别时返回 null。
 */
function normalizeLang(lang) {
  if (!lang) return null;

  const value = String(lang).trim().replace('_', '-');
  if (SUPPORTED_LANGS.includes(value)) return value;

  const lower = value.toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh-cn') || lower.startsWith('zh-hans') || lower.startsWith('zh-sg')) {
    return 'zh-CN';
  }
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hant') || lower.startsWith('zh-hk') || lower.startsWith('zh-mo')) {
    return 'zh-TW';
  }
  if (lower === 'en' || lower.startsWith('en-')) return 'en';

  return null;
}

/**
 * 根据浏览器语言列表选择最接近的页面语言，无法匹配时回落到简体中文。
 * @returns {string} 初始化时可直接应用的语言代码。
 */
function detectPreferredLang() {
  const browserLangs = navigator.languages?.length ? navigator.languages : [navigator.language];

  for (const browserLang of browserLangs) {
    const normalizedLang = normalizeLang(browserLang);
    if (normalizedLang) return normalizedLang;
  }

  return 'zh-CN';
}

/**
 * 决定页面初始语言：用户手动选择优先，其次浏览器自动识别，最后回落到简体中文。
 * @returns {string} 页面初始语言代码。
 */
function getInitialLang() {
  return normalizeLang(localStorage.getItem('fateclaw-lang')) || detectPreferredLang();
}

let currentLang = getInitialLang();

/**
 * 深合并基础字典和页面字典，让详情页复用导航、页脚等公共文案。
 * @param {Record<string, unknown>} base 基础语言字典。
 * @param {Record<string, unknown>} override 当前页面的语言字典。
 * @returns {Record<string, unknown>} 合并后的语言字典。
 */
function mergeDict(base, override) {
  const result = { ...base };

  Object.entries(override || {}).forEach(([key, value]) => {
    const baseValue = result[key];
    const shouldMerge = value
      && !Array.isArray(value)
      && typeof value === 'object'
      && baseValue
      && !Array.isArray(baseValue)
      && typeof baseValue === 'object';

    result[key] = shouldMerge ? mergeDict(baseValue, value) : value;
  });

  return result;
}

/**
 * 读取当前页面对应的语言字典，详情页通过 body[data-page] 追加自己的内容。
 * @param {string} lang 目标语言代码。
 * @returns {Record<string, unknown> | null} 当前页面可用的语言字典。
 */
function getDict(lang) {
  const baseDict = i18n[lang];
  if (!baseDict) return null;

  const pageKey = document.body?.dataset.page;
  const pageDict = window.FateClawPageI18n?.[pageKey]?.[lang];
  return pageDict ? mergeDict(baseDict, pageDict) : baseDict;
}

/**
 * 应用语言到页面，并按需记录用户的手动选择。
 * @param {string} lang 目标语言代码。
 * @param {boolean} shouldPersist 是否写入本地缓存。
 * @returns {void}
 */
function setLang(lang, shouldPersist) {
  const nextLang = normalizeLang(lang) || 'zh-CN';
  const dict = getDict(nextLang);
  currentLang = nextLang;
  if (shouldPersist) {
    localStorage.setItem('fateclaw-lang', nextLang);
  }
  document.querySelectorAll('.lang-btn').forEach(btn => {
    const isActive = btn.dataset.lang === nextLang;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  document.documentElement.lang = nextLang === 'en' ? 'en' : nextLang;
  document.title = dict?.pageTitle || '小奕想要三合木';
  applyTranslations(nextLang);
}

/**
 * 切换页面语言，并记录用户主动选择，供后续访问继续使用。
 * @param {string} lang 目标语言代码。
 * @returns {void}
 */
function switchLang(lang) {
  setLang(lang, true);
}

/**
 * 将语言字典里的文案同步到带有 data-i18n 标记的页面节点。
 * @param {string} lang 目标语言代码。
 * @returns {void}
 */
function applyTranslations(lang) {
  const dict = getDict(lang);
  if (!dict) return;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const parts = el.dataset.i18n.split('.');
    let value = dict;
    for (const part of parts) { value = value?.[part]; }
    if (value == null) return;
    if (Array.isArray(value)) {
      const listItems = value.map(item => {
        const li = document.createElement('li');
        li.textContent = item;
        return li;
      });
      el.replaceChildren(...listItems);
    } else {
      el.textContent = value;
    }
  });

  document.querySelectorAll('[data-i18n-svg]').forEach(el => {
    const parts = el.dataset.i18nSvg.split('.');
    let value = dict;
    for (const part of parts) { value = value?.[part]; }
    if (value) el.textContent = value;
  });
}

/**
 * 初始化页面语言，用浏览器偏好或用户上次选择同步首屏文案。
 * @returns {void}
 */
function initLang() {
  setLang(currentLang, false);
}

window.FateClawI18n = {
  init: initLang,
  switchLang,
};
})();
