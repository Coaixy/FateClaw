export const MEMORY_MAX_SEARCH_TERMS = 12;
export const MEMORY_MAX_SEARCH_TERM_LENGTH = 32;

const MAX_INPUT_TERMS = MEMORY_MAX_SEARCH_TERMS * 4;
const MAX_TOPIC_TEXT_LENGTH = 4000;

/** Search metadata is bounded independently of source text and never supplies evidence. */
export function normalizeMemorySearchTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of value.slice(0, MAX_INPUT_TERMS)) {
    if (
      typeof item !== 'string' ||
      item.length > MEMORY_MAX_SEARCH_TERM_LENGTH * 4
    )
      continue;
    const term = item.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (
      !term ||
      [...term].length > MEMORY_MAX_SEARCH_TERM_LENGTH ||
      /[\p{Cc}\p{Cf}]/u.test(term) ||
      !/[\p{L}\p{N}]/u.test(term)
    )
      continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MEMORY_MAX_SEARCH_TERMS) break;
  }
  return terms;
}

interface MemorySearchTopic {
  factKeys: readonly string[];
  terms: readonly string[];
  statements: readonly RegExp[];
  queries: readonly RegExp[];
}

// These rules recognize a small set of personal-information topics, not arbitrary
// meanings or facts. Model-supplied labels cover other topics without expanding
// this classifier, and neither path can decide a subject, assertion or fact value.
const SEARCH_TOPICS: readonly MemorySearchTopic[] = [
  {
    factKeys: ['occupation'],
    terms: ['职业', '工作'],
    statements: [
      /(?:职业|岗位|职位|工作单位)(?:是|为|[:：])|(?:就职于|任职于|供职于)[^，。；;!?？!\n]{1,40}|从事[^，。；;!?？!\n]{0,32}(?:工作|行业|职业|开发|设计|教学|销售|运营|客服|管理|诊疗|护理|研究|医疗|教育|金融|建筑|餐饮|物流|农业|软件|咨询|翻译|会计|法律|艺术|写作|媒体|互联网|电商)|(?:在|于)[^，。；;!?？!\n]{1,40}(?:工作|上班|任职|任教|执业)/u,
      /(?:是|当|做|担任|成为|作为|任)[^，。；;!?？!\n]{0,12}(?:医生|医师|护士|教师|老师|教授|讲师|工程师|程序员|开发者|设计师|律师|会计师?|审计师|研究员|科研人员|公务员|警察|军人|厨师|司机|销售员|经理|保安|工人|农民|记者|编辑|翻译|咨询师|治疗师|药师|兽医|交易员|企业主|创业者|个体户|自由职业者)(?=$|[，。；;!?？!、\s]|的工作|已经|已有|了)/u,
      /(?:负责|主要做|日常做)[^，。；;!?？!\n]{0,24}(?:开发|设计|教学|销售|运营|客服|管理|诊疗|护理|研究)/u,
      /\b(?:work(?:s|ed|ing)?|employed)\s+(?:as|at|for|in)\b|\b(?:occupation|profession|job)\s*(?:is\b|:)|\b(?:I am|I'm|he is|she is|they are)\s+(?:an?\s+)?(?:[a-z-]+\s+){0,3}(?:doctor|surgeon|nurse|teacher|engineer|developer|programmer|designer|lawyer|accountant|researcher|professor|manager|driver|chef)\b/iu,
    ],
    queries: [
      /职业|从事.{0,12}(?:什么|哪|啥|行业)|(?:做|干).{0,8}(?:什么|哪|啥).{0,8}工作|(?:什么|哪种|啥)工作|工作(?:是|类型|内容|单位)|(?:在哪|哪里|哪家).{0,12}(?:工作|上班|任职)/u,
      /\b(?:occupation|profession|career|job)\b|\bwhat\s+(?:do|did|does)\b.{0,32}\b(?:do|work)\b|\bwhere\b.{0,32}\bwork\b/iu,
    ],
  },
  {
    factKeys: ['birth_date'],
    terms: ['出生日期', '生日'],
    statements: [
      /生日|出生日期|(?:出生于|出生在|生于)\s*(?:公历|农历|阳历|阴历)?\s*(?:\d{2,4}\s*(?:年|[-/]\d)|\d{1,2}\s*月)|\d{2,4}\s*年[^，。；;!?？!\n]{0,16}(?:出生|生人)/u,
      /\b(?:birthday|date of birth|born (?:on|in)\s+\d{1,4})\b/iu,
    ],
    queries: [
      /生日|出生日期|(?:哪年|哪天|几月|几号|年月日).{0,8}出生|出生.{0,8}(?:哪年|哪天|几月|几号|年月日)|什么时候出生/u,
      /\b(?:birthday|date of birth|when\b.{0,16}\bborn|birth date)\b/iu,
    ],
  },
  {
    factKeys: ['birth_time'],
    terms: ['出生时间', '出生时辰'],
    statements: [
      /出生(?:时间|时辰)|(?:[零〇一二两三四五六七八九十\d]{1,3}(?:点|时)(?:[零〇一二两三四五六七八九十\d]{1,3}分?)?|[0-2]?\d[:：][0-5]\d)[^，。；;!?？!\n]{0,8}出生|出生(?:于|在)?\s*(?:凌晨|早上|上午|中午|下午|晚上|夜里)?\s*(?:[零〇一二两三四五六七八九十\d]{1,3}(?:点|时)|[0-2]?\d[:：][0-5]\d)|(?:子|丑|寅|卯|辰|巳|午|未|申|酉|戌|亥)时出生/u,
      /\b(?:birth time|time of birth|born at\s+\d{1,2})\b/iu,
    ],
    queries: [
      /出生(?:时间|时辰)|(?:几点|什么时辰|哪个时辰).{0,8}出生|出生.{0,8}(?:几点|什么时辰|哪个时辰)/u,
      /\b(?:birth time|time of birth|what time\b.{0,16}\bborn)\b/iu,
    ],
  },
  {
    factKeys: ['gender'],
    terms: ['性别'],
    statements: [
      /性别(?:是|为|[:：])?\s*(?:男|女)|(?:我|本人|他|她|客户)(?:是(?:个|一名|一位)?|为)?(?:男性|女性|男生|女生|男|女)(?:的)?(?=$|[，。；;!?？!\s])/u,
      /\b(?:gender\s*(?:is|:)\s*|I am\s+|I'm\s+)(?:male|female|nonbinary)\b/iu,
    ],
    queries: [
      /性别|(?:我是|我是个|我是男的还是|我是男生还是).{0,4}(?:男|女)|(?:男|女).{0,6}还是(?:男|女)/u,
      /\b(?:gender|male or female)\b/iu,
    ],
  },
  {
    factKeys: ['birthplace'],
    terms: ['出生地'],
    statements: [
      /出生地|(?:出生在|出生于|生于)\s*(?!\d|[零〇一二三四五六七八九十]{2}|公历|农历|阳历|阴历|凌晨|早上|上午|中午|下午|晚上|夜里|[子丑寅卯辰巳午未申酉戌亥]时)[\p{L}]{1,24}|在(?!凌晨|早上|上午|中午|下午|晚上|夜里)[\p{L}]{1,24}出生/u,
      /\b(?:birthplace|place of birth|born in\s+[a-z][a-z-]*)\b/iu,
    ],
    queries: [
      /出生地|(?:哪里|哪儿|哪座|哪个地方|什么地方|哪一座).{0,8}出生|出生.{0,8}(?:哪里|哪儿|哪座|哪个地方|什么地方|哪一座)/u,
      /\b(?:birthplace|place of birth|where\b.{0,16}\bborn)\b/iu,
    ],
  },
  {
    factKeys: ['residence'],
    terms: ['居住地', '住址'],
    statements: [
      /(?:现居|(?:居住|常住|定居)(?:在|于)|住在|居住地(?:是|为|[:：])|住址(?:是|为|[:：])|(?:我家|住处)(?:在|位于))[^，。；;!?？!\n]{1,40}/u,
      /\b(?:I live|I'm living|I am living|reside|residing)\s+in\b|\b(?:residence|home address)\s*(?:is|:)/iu,
    ],
    queries: [
      /居住地|住址|现居|(?:住|居住|定居)(?:在)?(?:哪|什么地方)|(?:哪里|哪儿|哪座城市).{0,8}(?:居住|生活)|生活在(?:哪|什么地方)/u,
      /\b(?:residence|home address|where\b.{0,16}\b(?:live|living|reside))\b/iu,
    ],
  },
  {
    factKeys: ['communication_preference'],
    terms: ['沟通偏好', '回答风格'],
    statements: [
      /(?:回答|回复|解释|沟通|交流|聊天)[^，。；;!?？!\n]{0,32}(?:简洁|简短|精简|详细|具体|直接|清晰|通俗|条理|分点|列表|中文|英文|英语|汉语)|(?:简洁|简短|精简|详细|具体|直接|清晰|通俗|条理|分点|列表|中文|英文|英语|汉语)[^，。；;!?？!\n]{0,32}(?:回答|回复|解释|沟通|交流|聊天)/u,
      /(?:希望|喜欢|偏好)[^，。；;!?？!\n]{0,8}(?:你|您)[^，。；;!?？!\n]{0,32}(?:回答|回复|解释|称呼|叫我)|(?:称呼我|叫我)[^，。；;!?？!\n]{1,20}/u,
      /\b(?:prefer|like|want)\b.{0,40}\b(?:answers?|replies|responses?|explanations?)\b|\b(?:answers?|replies|responses?|explanations?)\b.{0,32}\b(?:concise|brief|detailed|Chinese|English)\b/iu,
    ],
    queries: [
      /沟通偏好|回答风格|回复风格|(?:希望|喜欢|偏好).{0,16}(?:怎么|如何|什么风格|什么语言).{0,16}(?:回答|回复|解释|沟通|交流)|(?:怎么|如何|什么风格|什么语言).{0,16}(?:回答|回复|解释|沟通|交流)|(?:回答|回复|沟通|交流).{0,16}(?:偏好|风格|习惯|语言)|(?:怎么|如何)称呼/u,
      /\b(?:communication preferences?|response style|answer style|preferred language)\b|\bhow\b.{0,24}\b(?:answer|reply|respond|address)\b/iu,
    ],
  },
];

function topicText(text: string): string {
  return text.slice(0, MAX_TOPIC_TEXT_LENGTH).normalize('NFKC');
}

/** Derive retrieval labels only; callers must retain content and attribution verbatim. */
export function deriveMemorySearchTerms(
  content: string,
  factKey?: string | null,
  searchTerms?: readonly string[] | null,
): string[] {
  const text = topicText(content);
  const key = factKey?.normalize('NFKC').trim().toLowerCase();
  const topics = SEARCH_TOPICS.filter(
    (topic) =>
      (key && topic.factKeys.includes(key)) ||
      topic.statements.some((pattern) => pattern.test(text)),
  );
  return normalizeMemorySearchTerms([
    ...topics.flatMap((topic) => topic.terms),
    ...(searchTerms ?? []),
  ]);
}

/** Add these labels to lexical query terms; they never select an identity or fact value. */
export function expandMemoryQueryTerms(query: string): string[] {
  const text = topicText(query);
  return normalizeMemorySearchTerms(
    SEARCH_TOPICS.filter((topic) =>
      topic.queries.some((pattern) => pattern.test(text)),
    ).flatMap((topic) => topic.terms),
  );
}

type InferredMemoryFactKey =
  | 'birth_date'
  | 'birth_time'
  | 'gender'
  | 'birthplace'
  | 'residence'
  | 'occupation';

const FIELD_STATEMENTS: Readonly<
  Record<InferredMemoryFactKey, readonly RegExp[]>
> = {
  birth_date: [
    /^(?:我的?|本人(?:的)?)?(?:生日|出生日期)(?:是|为|[:：])\s*\S+/u,
    /^(?:我|本人)(?:是)?(?:在|于)?(?:公历|农历|阳历|阴历)?\s*\d{2,4}\s*年(?:[^，。；;!?？!\n]{0,16})?(?:出生|生人)(?:的)?$/u,
    /^(?:我|本人)(?:出生于|出生在|生于)\s*(?:公历|农历|阳历|阴历)?\s*\d{2,4}\s*年[^，。；;!?？!\n]*$/u,
    /^(?:my\s+(?:birthday|date of birth)\s+is|I\s+was\s+born\s+(?:on|in)\s+\d{1,4})\b/iu,
  ],
  birth_time: [
    /^(?:我的?|本人(?:的)?)?(?:出生时间|出生时辰)(?:是|为|[:：])\s*\S+/u,
    /^(?:我|本人)(?:是)?(?:在|于)?(?:凌晨|早上|上午|中午|下午|晚上|夜里)?\s*(?:[零〇一二两三四五六七八九十\d]{1,3}(?:点|时)(?:[零〇一二两三四五六七八九十\d]{1,3}分?|半|一刻|三刻)?|[0-2]?\d[:：][0-5]\d)出生(?:的)?$/u,
    /^(?:我|本人)出生(?:于|在)?\s*(?:凌晨|早上|上午|中午|下午|晚上|夜里)?\s*(?:[零〇一二两三四五六七八九十\d]{1,3}(?:点|时)(?:[零〇一二两三四五六七八九十\d]{1,3}分?|半|一刻|三刻)?|[0-2]?\d[:：][0-5]\d)$/u,
    /^my\s+(?:birth time|time of birth)\s+is\b|^I\s+was\s+born\s+at\s+\d/iu,
  ],
  gender: [
    /^(?:我的?|本人(?:的)?)?(?:性别)(?:是|为|[:：])?\s*(?:男|女|男性|女性|男生|女生)$/u,
    /^(?:我|本人)(?:是(?:个|一名|一位)?|为)?(?:男性|女性|男生|女生|男|女)(?:的)?$/u,
    /^(?:my\s+gender\s+is\s+|I am\s+|I'm\s+)(?:male|female|nonbinary)$/iu,
  ],
  birthplace: [
    /^(?:我的?|本人(?:的)?)?出生地(?:是|为|[:：])\s*\S+/u,
    /^(?:我|本人)(?:是)?(?:出生在|出生于|生于)\s*(?!\d|[零〇一二三四五六七八九十]{2}|公历|农历|阳历|阴历|凌晨|早上|上午|中午|下午|晚上|夜里|[子丑寅卯辰巳午未申酉戌亥]时)[\p{L}·\s]{1,32}(?:出生|的)?$/u,
    /^(?:我|本人)(?:是)?在(?!凌晨|早上|上午|中午|下午|晚上|夜里)[\p{L}·\s]{1,32}出生(?:的)?$/u,
    /^my\s+(?:birthplace|place of birth)\s+is\b|^I\s+was\s+born\s+in\s+[a-z]/iu,
  ],
  residence: [
    /^(?:我的?|本人(?:的)?)?(?:居住地|住址)(?:是|为|[:：])\s*\S+/u,
    /^(?:我|本人)(?:现在|目前|长期|一直|暂时)?(?:住在|现居|(?:居住|常住|定居)(?:在|于))[^，。；;!?？!\n]{1,40}$/u,
    /^(?:I live|I'm living|I am living|I reside)\s+in\s+\S+|^my\s+(?:residence|home address)\s+is\b/iu,
  ],
  occupation: [
    // Employer and duty statements can coexist with a profession, so they stay unkeyed.
    /^(?:我的?|本人(?:的)?)?职业(?:是|为|[:：])\s*\S+/u,
    /^(?:我|本人)(?:现在|目前|一直)?(?:是|当|做|担任|任)(?:一名|一位|一个|名)?[\p{L}]{0,12}(?:医生|医师|护士|教师|老师|教授|讲师|工程师|程序员|开发者|设计师|律师|会计师?|审计师|研究员|科研人员|公务员|警察|军人|厨师|司机|销售员|经理|保安|工人|农民|记者|编辑|翻译|咨询师|治疗师|药师|兽医|交易员|企业主|创业者|个体户|自由职业者)$/u,
    /^(?:我|本人)从事[\p{L}]{1,24}(?:这一|这个)?职业$/u,
    /^(?:I am|I'm)\s+(?:an?\s+)?(?:[a-z-]+\s+){0,3}(?:doctor|surgeon|nurse|teacher|engineer|developer|programmer|designer|lawyer|accountant|researcher|professor|manager|driver|chef)$|^my\s+(?:occupation|profession|job)\s+is\b/iu,
  ],
};

/** Classify one explicit self statement; ambiguity must not create a conflict key. */
export function inferMemoryFactKey(content: string): string | undefined {
  if (content.length > 1600) return undefined;
  const text = topicText(content)
    .trim()
    .replace(/[。.!！]+$/u, '')
    .trim();
  if (
    !text ||
    /[，,。；;!?？!\n]|(?<!\d)\.(?!\d)/u.test(text) ||
    /(?:如果|要是|假设|假如|可能|也许|好像|大概|听说|据说|计划|打算|希望|想(?:当|做|成为|让|要)|准备(?:当|做|成为|去|要)|将要|将会|明天|明年|下周|下个月|未来|并且|而且|同时|另外|此外|然后|但是|不过)|(?:说|讲|认为)\s*[:：]?\s*[“「『"]|(?:朋友|他|她|你|模型|AI)(?:说|认为)|(?:我|本人).+(?:我|本人)|(?:他|她|父亲|母亲|爸爸|妈妈|朋友|客户)(?:是|在|住|从事)|\b(?:if|maybe|perhaps|might|plan|want|wish|will|tomorrow|next year|next month|next week)\b/iu.test(
      text,
    )
  )
    return undefined;
  const topics = SEARCH_TOPICS.filter((topic) =>
    topic.statements.some((pattern) => pattern.test(text)),
  );
  // A field label can identify a terse value, while unlabelled fragments cannot.
  const keys = (
    Object.keys(FIELD_STATEMENTS) as InferredMemoryFactKey[]
  ).filter(
    (key) =>
      FIELD_STATEMENTS[key].some((pattern) => pattern.test(text)) &&
      topics.some((topic) => topic.factKeys.includes(key)),
  );
  if (
    keys.length !== 1 ||
    topics.some((topic) => !topic.factKeys.includes(keys[0]))
  )
    return undefined;
  if (
    keys[0] === 'occupation' &&
    !FIELD_STATEMENTS.occupation[0].test(text) &&
    /(?:喜欢|需要|寻找|想|请|看|认识|帮助|联系|感谢|了解|学习|准备|打算|计划|希望|咨询(?!师))/u.test(
      text,
    )
  )
    return undefined;
  return keys[0];
}
