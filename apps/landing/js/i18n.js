// ================================================================
// 多语言
// ================================================================
(function () {
const i18n = {
  'zh-CN': {
    pageTitle: '小奕想要三合木',
    nav: { logoCn: '命枢', features: '核心流程', architecture: '命与运', faq: 'FAQs' },
    hero: {
      headline: '东方玄学智能体',
      subEn: 'The Eastern Metaphysics Agent',
      subCn: '排盘、Tool、Skill 与 LLM 协同',
      description: '融合本地确定性排盘、用户知识库检索与 AI 智能解读的玄学 Agent，拥有 Skill 垂类工具等现代 Agent 能力。',
      cta1: '马上体验',
    },
    features: {
      title: '一次解读的真实流转',
      subtitle: '先由排盘引擎确定盘面，再由 LLM 围绕问题调用 Tool 与 Skill，最后生成可复盘结果。',
      flow1Label: '排盘',
      flow1Title: '确定盘面',
      flow1Desc: '八字、紫微、奇门、六爻、经占先由确定性引擎计算，输出结构化盘面。',
      flow2Label: 'LLM',
      flow2Title: '理解问题',
      flow2Desc: '模型围绕用户问题拆解推理路径，决定需要读取哪些盘面、规则与上下文。',
      flow3Label: 'Tool Skill',
      flow3Title: '调用能力',
      flow3Desc: 'Tool 负责历法、干支、命盘读取等确定性动作；Skill 负责读取授权流派规则。',
      flow4Label: 'Result',
      flow4Title: '生成结果',
      flow4Desc: '最终输出结论、依据与可复盘轨迹，让解读不是一段黑箱文案。',
      note: '核心关系是 LLM 与 Tool Skill 双向协作：模型提出需求，工具返回可验证材料，模型再组织为可读结果。',
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
      a6: '当前页面展示的核心方向包括八字、紫微斗数、奇门遁甲、六爻纳甲和周易经占，后续能力以实际产品开放为准。',
    },
    footer: { logoCn: '命枢', copy: '© 2026 FateClaw。东方玄学智能体。', icp: '浙ICP备2024132053号' },
  },

  'zh-TW': {
    pageTitle: '小奕想要三合木',
    nav: { logoCn: '命樞', features: '核心流程', architecture: '命與運', faq: 'FAQs' },
    hero: {
      headline: '東方玄學智能體',
      subEn: 'The Eastern Metaphysics Agent',
      subCn: '排盤、Tool、Skill 與 LLM 協同',
      description: '融合本地確定性排盤、用戶知識庫檢索與 AI 智能解讀的玄學 Agent，擁有 Skill 垂類工具等現代 Agent 能力。',
      cta1: '馬上體驗',
    },
    features: {
      title: '一次解讀的真實流轉',
      subtitle: '先由排盤引擎確定盤面，再由 LLM 圍繞問題呼叫 Tool 與 Skill，最後生成可復盤結果。',
      flow1Label: '排盤',
      flow1Title: '確定盤面',
      flow1Desc: '八字、紫微、奇門、六爻、經占先由確定性引擎計算，輸出結構化盤面。',
      flow2Label: 'LLM',
      flow2Title: '理解問題',
      flow2Desc: '模型圍繞用戶問題拆解推理路徑，決定需要讀取哪些盤面、規則與上下文。',
      flow3Label: 'Tool Skill',
      flow3Title: '呼叫能力',
      flow3Desc: 'Tool 負責曆法、干支、命盤讀取等確定性動作；Skill 負責讀取授權流派規則。',
      flow4Label: 'Result',
      flow4Title: '生成結果',
      flow4Desc: '最終輸出結論、依據與可復盤軌跡，讓解讀不是一段黑箱文案。',
      note: '核心關係是 LLM 與 Tool Skill 雙向協作：模型提出需求，工具返回可驗證材料，模型再組織為可讀結果。',
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
      a6: '當前頁面展示的核心方向包括八字、紫微斗數、奇門遁甲、六爻納甲和周易經占，後續能力以實際產品開放為準。',
    },
    footer: { logoCn: '命樞', copy: '© 2026 FateClaw。東方玄學智能體。', icp: '浙ICP备2024132053号' },
  },

  'en': {
    pageTitle: 'FateClaw | AI-Powered Chinese Metaphysics',
    nav: { logoCn: '', features: 'Flow', architecture: 'Fate / Fortune', faq: 'FAQs' },
    hero: {
      headline: 'AI-Powered Chinese Metaphysics',
      subEn: 'The Eastern Metaphysics Agent',
      subCn: 'Charting, Tools, Skills, and LLM in one loop',
      description: 'A metaphysics Agent system that fuses deterministic charting, user knowledge retrieval, and AI interpretation with modern Skills and Tools.',
      cta1: 'Try It Now',
    },
    features: {
      title: 'How One Reading Moves',
      subtitle: 'The charting engine fixes the board first. The LLM then calls Tools and Skills around the question, and returns a traceable result.',
      flow1Label: 'Charting',
      flow1Title: 'Fix the board',
      flow1Desc: 'BaZi, ZiWei, QiMen, LiuYao, and JingZhan are computed by deterministic engines into structured chart data.',
      flow2Label: 'LLM',
      flow2Title: 'Read the question',
      flow2Desc: 'The model breaks down the user question and decides which charts, rules, and context it needs to inspect.',
      flow3Label: 'Tool Skill',
      flow3Title: 'Call capabilities',
      flow3Desc: 'Tools handle calendar, GanZhi, and chart lookups. Skills load authorized school rules and interpretation boundaries.',
      flow4Label: 'Result',
      flow4Title: 'Return the reading',
      flow4Desc: 'The final answer carries conclusions, reasoning, and traceable material instead of opaque generated copy.',
      note: 'The core loop is bidirectional: the LLM asks, Tools and Skills return verifiable material, and the model turns it into a readable result.',
    },
    arch: {
      title: 'Fate, Fortune, and Choice',
      subtitle: 'Fate is the vehicle. Fortune is the road. FateClaw reads the structure first, then looks at road conditions, timing, and forks where choice matters.',
      destinyLabel: 'Fate',
      destinyTitle: 'Fate is the vehicle',
      destinyDesc: 'Fate is closer to the chassis, engine, and carrying capacity: the base structure, inertia, strengths, and points of easy depletion.',
      destinyProsTitle: 'What it reads',
      destinyPros: 'It reads configuration, temperament, long-term tendency, and phase rhythm. It answers how this vehicle is best driven.',
      destinyConsTitle: 'Boundary',
      destinyCons: 'The vehicle is not the full outcome. The same vehicle can feel very different across roads, speeds, and choices.',
      divinationLabel: 'Fortune',
      divinationTitle: 'Fortune is the road',
      divinationDesc: 'Fortune is the road being traveled: environment, phase openings, resistance, timing, and forks that need present judgment.',
      divinationProsTitle: 'Divination reads the road',
      divinationPros: 'Divination narrows the question to the current junction and helps compare road conditions, timing, risks, and opportunity costs.',
      divinationConsTitle: 'Choice changes the route',
      divinationCons: 'Choice does not magically replace the vehicle, but it affects when to start, where to turn, what to avoid, and which road the vehicle enters.',
      choiceTitle: 'Divination does not rewrite fate. It helps choose the route.',
      choiceDesc: 'The chart gives the vehicle structure. Divination gives the signal at the current junction. Fortune often changes through the choices, rhythm, and actions made after the road is seen clearly.',
    },
    faq: {
      title: 'FAQs',
      subtitle: 'Clear boundaries matter: FateClaw charts and assists interpretation. It does not turn metaphysics into an absolute verdict.',
      q1: 'Is FateClaw a fortune-telling tool or an AI chat?',
      a1: 'It first computes charts through deterministic engines, then lets the LLM interpret with Tools, Skills, and the user question. The AI works from structured material instead of inventing charts.',
      q2: 'Can divination and destiny analysis be used together?',
      a2: 'Yes. Destiny analysis gives long-term background, while divination handles the present question. The key is to keep clear which method answers which part.',
      q3: 'Can the LLM hallucinate conclusions?',
      a3: 'FateClaw is designed to make charting, tool calls, and Skill sources traceable, which narrows free-form model output. The reading is still a reference, not absolute fact.',
      q4: 'What is a Skill here?',
      a4: 'A Skill stores school rules, case experience, and interpretation boundaries from creators. The LLM loads authorized Skills when needed.',
      q5: 'Can I use results for real-world decisions?',
      a5: 'Not directly. Results are useful for reflection and alternative framing, but they do not replace legal, medical, financial, investment, or other professional advice.',
      q6: 'Which systems are supported?',
      a6: 'The current direction shown here includes BaZi, ZiWei DouShu, QiMen Dunjia, LiuYao Najia, and Zhouyi JingZhan. Actual availability follows the live product.',
    },
    footer: { logoCn: '', copy: '© 2026 FateClaw. AI-Powered Chinese Metaphysics.', icp: '' },
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
 * 应用语言到页面，并按需记录用户的手动选择。
 * @param {string} lang 目标语言代码。
 * @param {boolean} shouldPersist 是否写入本地缓存。
 * @returns {void}
 */
function setLang(lang, shouldPersist) {
  const nextLang = normalizeLang(lang) || 'zh-CN';
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
  document.title = i18n[nextLang]?.pageTitle || '小奕想要三合木';
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
  const dict = i18n[lang];
  if (!dict) return;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const parts = el.dataset.i18n.split('.');
    let value = dict;
    for (const part of parts) { value = value?.[part]; }
    if (value == null) return;
    if (Array.isArray(value)) {
      el.innerHTML = value.map(v => '<li>' + v + '</li>').join('');
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
