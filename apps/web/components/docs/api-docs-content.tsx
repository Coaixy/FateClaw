'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';

import { AppShell } from '@/components/app-shell';
import { getApiBase } from '@/lib/http/client';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

const METHOD_STYLE: Record<HttpMethod, string> = {
  GET: 'text-emerald-600 bg-emerald-500/10',
  POST: 'text-sky-600 bg-sky-500/10',
  DELETE: 'text-rose-600 bg-rose-500/10',
};

/** 必填状态：是=必填、否=可选、条件=由起卦方式等决定。 */
type ReqState = '是' | '否' | '条件';

/** 一行参数说明。 */
type ParamRow = {
  name: string;
  type: string;
  req: ReqState;
  def: string;
  constraints: string;
  desc: string;
};

/** 单个排盘类型的对外规格（已对齐后端实现，并简化为调用方视角）。 */
type PaipanSpec = {
  id: string;
  type: string;
  name: string;
  summary: string;
  params: ParamRow[];
  rules: string[];
  example: string;
  returns: string;
  tips: string[];
};

/** 7 种排盘的对外规格。参数名为对外 snake_case，必填/默认与后端校验一致。 */
const PAIPAN_SPECS: PaipanSpec[] = [
  {
    id: 'paipan-bazi',
    type: 'bazi',
    name: '八字排盘',
    summary: '根据阳历生日、出生小时和性别，算出四柱、大运、逐年流年和格局。可用 include 只取其中几部分。',
    params: [
      { name: 'solar_date', type: 'string', req: '是', def: '', constraints: 'YYYY-MM-DD（例 2000-08-16）', desc: '阳历出生日期。' },
      { name: 'hour', type: 'integer', req: '是', def: '', constraints: '0–23（24 小时制）', desc: '出生小时，允许 0。' },
      { name: 'minute', type: 'integer', req: '否', def: '0', constraints: '0–59', desc: '出生分钟，影响早晚子时与起运精度。' },
      { name: 'gender', type: 'string', req: '是', def: '', constraints: '男 | 女 | male | female', desc: '性别（male/female 会归一化为 男/女）。' },
      { name: 'zishi_mode', type: 'string', req: '否', def: 'early', constraints: 'early | late', desc: '子时切换：early=23:00 起算次日，late=算当日。' },
      { name: 'child_limit_mode', type: 'string', req: '否', def: 'default', constraints: 'default | china95 | lunar_sect1 | lunar_sect2', desc: '起运（童限）算法。' },
      { name: 'include', type: 'array', req: '否', def: '全部', constraints: 'items ∈ bazi | fortune | pattern', desc: '要返回的部分，省略 = 全返回。' },
    ],
    rules: [
      '必填：solar_date、hour、gender。',
      'include 省略 = 返回命盘（bazi）、运势（fortune）、格局（pattern）三部分。',
    ],
    example: `{
  "solar_date": "2000-08-16",
  "hour": 14,
  "gender": "male"
}`,
    returns: 'text 是中文盘面（命盘概要、四柱明细、起运、大运小运、逐年流年），可直接展示或交给模型解读。',
    tips: [
      'include 只填 pattern 时不会有文字盘面（text 为空），想要文字至少带上 bazi 或 fortune。',
      '逐年流年可能上百条，响应体较大。',
    ],
  },
  {
    id: 'paipan-ziwei',
    type: 'ziwei',
    name: '紫微斗数排盘',
    summary: '根据阳历生日、出生小时和性别生成十二宫星盘，可选叠加大限 / 流年等运盘。',
    params: [
      { name: 'solar_date', type: 'string', req: '是', def: '', constraints: 'YYYY-MM-DD', desc: '阳历出生日期。' },
      { name: 'hour', type: 'integer', req: '是', def: '', constraints: '0–23', desc: '出生小时。' },
      { name: 'minute', type: 'integer', req: '否', def: '0', constraints: '0–59', desc: '目前不影响排盘结果。' },
      { name: 'gender', type: 'string', req: '是', def: '', constraints: '男 | 女 | male | female', desc: '性别。' },
      { name: 'fix_leap', type: 'boolean', req: '否', def: 'true', constraints: '—', desc: '是否修正闰月。' },
      { name: 'day_divide', type: 'string', req: '否', def: 'forward', constraints: 'forward | current', desc: '晚子时换日规则。' },
      { name: 'year_divide', type: 'string', req: '否', def: 'normal', constraints: 'normal | exact', desc: '年干支分界：农历新年 / 立春。' },
      { name: 'horoscope_divide', type: 'string', req: '否', def: 'normal', constraints: 'normal | exact', desc: '运限分界：农历新年 / 立春。' },
      { name: 'age_divide', type: 'string', req: '否', def: 'normal', constraints: 'normal | birthday', desc: '小限分界：自然年 / 生日。' },
      { name: 'horoscope', type: 'object', req: '否', def: '', constraints: '{ date, scopes }', desc: '可选：叠加运盘，填了 date 才生效。' },
      { name: 'horoscope.date', type: 'string', req: '条件', def: '', constraints: 'YYYY-MM-DD', desc: '运盘目标日期。' },
      { name: 'horoscope.scopes', type: 'array', req: '否', def: '[decadal, yearly]', constraints: 'decadal|age|yearly|monthly|daily|hourly', desc: '要返回的运盘尺度。' },
    ],
    rules: [
      '必填：solar_date、hour、gender。',
      '想叠加运盘时填 horoscope.date（可再带 horoscope.scopes）；不填 date 则不叠加。',
    ],
    example: `{
  "solar_date": "2000-08-16",
  "hour": 14,
  "gender": "male",
  "horoscope": { "date": "2026-04-17", "scopes": ["decadal", "yearly"] }
}`,
    returns: 'text 是中文星盘（命盘概要、生年四化、十二宫、流年四化，及叠加的运盘）。',
    tips: [
      'horoscope.date 漏填不会报错，但运盘不会叠加，容易误以为生效了。',
      'minute 目前不影响排盘结果。',
    ],
  },
  {
    id: 'paipan-iching',
    type: 'iching',
    name: '六爻排盘',
    summary: '六爻纳甲排盘。按起卦方式生成本卦 / 变卦 / 互卦、六亲六兽、世应、伏神、神煞等。',
    params: [
      { name: 'method', type: 'string', req: '否', def: 'dayan', constraints: 'dayan | lueshifa | manual | three | array | time', desc: '起卦方式。' },
      { name: 'yao', type: 'string', req: '条件', def: '', constraints: '6 位爻码，每位 6/7/8/9，例 "789678"', desc: 'method=manual 时必填。' },
      { name: 'numbers', type: 'array', req: '条件', def: '', constraints: 'three=3 个数、array≥2 个数', desc: 'method=three / array 时必填。' },
      { name: 'datetime', type: 'string', req: '否', def: '当前时间', constraints: '"YYYY-MM-DD HH:mm"', desc: 'method=time 起卦用；array 用其小时定起卦时辰；其余方式作四柱/月建/旬空。' },
    ],
    rules: [
      'method 决定要带哪些参数：manual 需 yao；three / array 需 numbers；time 用 datetime；dayan / lueshifa 直接随机起卦。',
    ],
    example: `{
  "method": "manual",
  "yao": "789678"
}`,
    returns: 'text 是完整中文卦盘（起卦概要、卦象关系、本卦六爻、伏神、神煞）。',
    tips: [
      '默认的 dayan 和 lueshifa 是随机起卦，每次结果都不同；要可复现请用 manual / three / array / time。',
    ],
  },
  {
    id: 'paipan-jingzhan',
    type: 'jingzhan',
    name: '经占排盘',
    summary: '经占排盘。和六爻用同一套参数，但只解卦辞与动爻爻辞，不含纳甲、六亲、世应、神煞。',
    params: [
      { name: 'method', type: 'string', req: '否', def: 'dayan', constraints: 'dayan | lueshifa | manual | three | array | time', desc: '起卦方式。' },
      { name: 'yao', type: 'string', req: '条件', def: '', constraints: '6 位爻码 6/7/8/9', desc: 'method=manual 时必填。' },
      { name: 'numbers', type: 'array', req: '条件', def: '', constraints: 'three=3 个数、array≥2 个数', desc: 'method=three / array 时必填。' },
      { name: 'datetime', type: 'string', req: '否', def: '当前时间', constraints: '"YYYY-MM-DD HH:mm"', desc: 'method=time 起卦用；array 用其小时定起卦时辰。' },
    ],
    rules: [
      'method 决定参数：同六爻；不带任何参数则按随机大衍起卦。',
    ],
    example: `{
  "method": "manual",
  "yao": "789678"
}`,
    returns: 'text 是卦辞 / 爻辞解读（起卦概要、卦象、经文取辞、爻值摘要）。',
    tips: [
      '和六爻参数相同但侧重不同：经占只看卦辞、爻辞，选类型时别混了。',
    ],
  },
  {
    id: 'paipan-meihua',
    type: 'meihua',
    name: '梅花易数排盘',
    summary: '梅花易数排盘。按时间 / 报数 / 指定上下卦三种方式起卦，给出本卦、互卦、变卦、错卦、综卦及体用生克。',
    params: [
      { name: 'method', type: 'string', req: '否', def: 'time', constraints: 'time | counts | trigrams', desc: '起卦方式，决定要带哪些参数。' },
      { name: 'datetime', type: 'string', req: '否', def: '当前时间', constraints: '"YYYY-MM-DD HH:mm"', desc: 'method=time 可选，不传用当前时间。' },
      { name: 'count_method', type: 'string', req: '否', def: 'number', constraints: 'number | word | sound | object | direction | external', desc: 'method=counts 的取数来源标注，不影响起卦结果。' },
      { name: 'upper', type: 'integer', req: '条件', def: '', constraints: '整数', desc: 'method=counts 必填：上卦取数。' },
      { name: 'lower', type: 'integer', req: '条件', def: '', constraints: '整数', desc: 'method=counts 必填：下卦取数。' },
      { name: 'moving', type: 'integer', req: '否', def: '', constraints: '整数', desc: 'method=counts 可选动爻；不传由 upper+lower 推导。' },
      { name: 'upper_trigram', type: 'string', req: '条件', def: '', constraints: '乾 兑 离 震 巽 坎 艮 坤', desc: 'method=trigrams 必填：上卦。' },
      { name: 'lower_trigram', type: 'string', req: '条件', def: '', constraints: '乾 兑 离 震 巽 坎 艮 坤', desc: 'method=trigrams 必填：下卦。' },
      { name: 'moving_line', type: 'integer', req: '条件', def: '', constraints: '1–6', desc: 'method=trigrams 必填：动爻。' },
      { name: 'label', type: 'string', req: '否', def: '', constraints: '—', desc: '可选备注，会回显在盘面。' },
    ],
    rules: [
      'method=time（默认）：可不带参数（用当前时间），也可传 datetime。',
      'method=counts：必填 upper、lower（可选 moving）。',
      'method=trigrams：必填 upper_trigram、lower_trigram、moving_line。',
    ],
    example: `{
  "method": "trigrams",
  "upper_trigram": "乾",
  "lower_trigram": "兑",
  "moving_line": 4
}`,
    returns: 'text 是中文盘面（起卦概要、五卦关系、体用、时间）。',
    tips: [
      '卦名要用中文（乾兑离震巽坎艮坤），不能用拼音或英文。',
      'method=time 不传 datetime 会用当前时间，结果不固定。',
    ],
  },
  {
    id: 'paipan-qimen',
    type: 'qimen',
    name: '奇门遁甲排盘',
    summary: '奇门遁甲排盘（拆补法）。按指定时间或当前时间起局，给出九宫、值符值使、八门九星、天地盘、马星等。',
    params: [
      { name: 'solar_date', type: 'string', req: '否', def: '', constraints: 'YYYY-MM-DD', desc: '阳历日期，不传用当前时间。' },
      { name: 'hour', type: 'integer', req: '否', def: '', constraints: '0–23', desc: '小时，不传用当前时间。' },
      { name: 'minute', type: 'integer', req: '否', def: '0', constraints: '0–59', desc: '与 solar_date/hour 一起传指定时间时生效。' },
    ],
    rules: [
      'solar_date 和 hour 要么都传、要么都不传；都不传则用服务器当前时间。',
    ],
    example: `{
  "solar_date": "2026-04-17",
  "hour": 14
}`,
    returns: 'text 是中文局盘（局盘概要、九宫盘、门迫、击刑）。',
    tips: [
      '需要后台为你启用「奇门遁甲」技能，否则会返回未启用错误。',
      '长生运不在 text 里，需要的话从结构化的 data 读取。',
    ],
  },
  {
    id: 'paipan-liuren',
    type: 'liuren',
    name: '大六壬排盘',
    summary: '大六壬排盘。按当前时间、指定时间或随机时辰起一课，返回天地盘、四课、三传、建除和神煞。',
    params: [
      { name: 'solar_date', type: 'string', req: '否', def: '', constraints: 'YYYY-MM-DD', desc: '阳历日期，不传用当前时间。' },
      { name: 'hour', type: 'integer', req: '否', def: '', constraints: '0–23', desc: '小时，通常与 solar_date 一起传。' },
      { name: 'minute', type: 'integer', req: '否', def: '0', constraints: '0–59', desc: '与 solar_date/hour 一起传时生效。' },
      { name: 'random_number', type: 'integer', req: '否', def: '', constraints: '整数', desc: '随机种子，固定它可让随机起课可复现。' },
      { name: 'time_mode', type: 'string', req: '否', def: '', constraints: 'now | custom | random', desc: '起课模式标识；random 时只传 hour 也不报错。' },
    ],
    rules: [
      '全部省略 = 用当前时间起课。',
      '要指定时间，solar_date 和 hour 一起传；想随机起课可只传 solar_date 或 random_number。',
    ],
    example: `{
  "solar_date": "2026-06-02",
  "hour": 12
}`,
    returns: 'text 是中文课盘（起课概要、四课、三传、天地盘、建除、神煞）。',
    tips: [
      '只传 hour 不传 solar_date 会报错（除非 time_mode=random）。',
      '随机起课想可复现，请固定 random_number。',
    ],
  },
];

/** Agent（解读）请求参数，含 fateclaw.* 扩展（点号表示嵌套）。 */
const AGENT_PARAMS: ParamRow[] = [
  { name: 'model', type: 'string', req: '是', def: '', constraints: '取 GET /api/v1/models 返回的 id', desc: '目标官方模型，只支持平台官方模型。' },
  { name: 'messages', type: 'array', req: '是', def: '', constraints: '≥1 条，且至少一条 role="user"', desc: 'OpenAI 风格消息数组，支持多轮（见下方说明）。' },
  { name: 'messages[].role', type: 'string', req: '是', def: '', constraints: 'system | user | assistant', desc: '消息角色。' },
  { name: 'messages[].content', type: 'string', req: '是', def: '', constraints: '允许空串', desc: '消息文本。' },
  { name: 'stream', type: 'boolean', req: '否', def: 'false', constraints: 'SSE 流式', desc: '是否流式返回（Server-Sent Events，OpenAI chunk 格式）。' },
  { name: 'stream_options.include_usage', type: 'boolean', req: '否', def: 'false', constraints: '仅 stream=true', desc: '流式时在末尾追加一条仅含 usage 的 chunk。' },
  { name: 'max_tokens', type: 'integer', req: '否', def: '模型默认', constraints: '正整数', desc: '本次输出 token 上限。' },
  { name: 'fateclaw', type: 'object', req: '否', def: '', constraints: 'OpenAI SDK 经 extra_body 传入', desc: 'FateClaw 扩展：skills / thinking_level / board。' },
  { name: 'fateclaw.skills', type: 'array', req: '否', def: '', constraints: 'UUID[]', desc: '开启的技能：你拥有/订阅且已启用的 skill id；无权或未启用的会被忽略。' },
  { name: 'fateclaw.thinking_level', type: 'string', req: '否', def: 'medium', constraints: 'off | minimal | low | medium | high | xhigh', desc: '思考等级。' },
  { name: 'fateclaw.board', type: 'object', req: '否', def: '', constraints: '{ type?, text?, data? }', desc: '排盘结果，通常回填 /api/v1/paipan 的输出。' },
  { name: 'fateclaw.board.type', type: 'string', req: '否', def: 'paipan', constraints: '—', desc: '盘面类型。' },
  { name: 'fateclaw.board.text', type: 'string', req: '否', def: '', constraints: '—', desc: '中文盘面文本（来自 /api/v1/paipan 的 text）。' },
  { name: 'fateclaw.board.data', type: 'unknown', req: '否', def: '', constraints: '任意 JSON', desc: '结构化盘面；仅当 text 缺失时兜底使用。' },
];

/** 错误码（调用方视角）。 */
const ERROR_CODES: Array<{ status: string; code: string; type: string; when: string }> = [
  { status: '401', code: 'invalid_api_key', type: 'invalid_request_error', when: 'Key 缺失、格式不对、无效、已吊销或已过期' },
  { status: '402', code: 'insufficient_quota', type: 'insufficient_quota', when: '积分欠费，需要补充积分' },
  { status: '403', code: 'membership_required', type: 'insufficient_quota', when: '会员已过期（续费后自动恢复）' },
  { status: '403', code: 'PAIPAN.SKILL_NOT_ENABLED', type: 'invalid_request_error', when: '该排盘类型未对你启用' },
  { status: '404', code: 'unknown_paipan_type', type: 'invalid_request_error', when: '排盘类型不存在' },
  { status: '400', code: 'PAIPAN.PARAM_INVALID', type: 'invalid_request_error', when: '排盘参数错误（缺必填、类型 / 枚举 / 范围不对）' },
  { status: '500', code: 'PAIPAN.EXECUTION_FAILED', type: 'invalid_request_error', when: '排盘执行出错（如时间非法、漏传该方式必需的参数）' },
  { status: '400', code: 'invalid_request', type: 'invalid_request_error', when: 'Agent 请求体有误，或没有 user 消息' },
  { status: '400', code: 'model_not_found', type: 'invalid_request_error', when: 'model 不是可用的官方模型' },
  { status: '502', code: 'agent_error', type: 'api_error', when: 'Agent 执行失败' },
  { status: '429', code: 'rate_limit_exceeded', type: 'rate_limit_exceeded', when: '调用过于频繁（带 Retry-After 头）' },
  { status: '500', code: 'internal_error', type: 'api_error', when: '服务器内部错误' },
];

/** 顶部 tab。 */
const TABS = [
  { id: 'start', label: '快速开始' },
  { id: 'paipan', label: '排盘' },
  { id: 'agent', label: '解读 · Agent' },
  { id: 'reference', label: '参考' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * 解析文档展示用的「API 公网基址」（不含 /api/v1）。
 *
 * 优先级：构建期注入的 PUBLIC_API_BASE_URL（后端同款，即 API 对外的真实公网地址）
 * > 前端请求基址 NEXT_PUBLIC_API_BASE > 运行时同源 origin。
 * 注意：origin 是「当前 web 页面」的地址，仅在 web 与 API 同源部署时才等于 API 地址，
 * 故只作最后兜底，不优先采用——避免把 web 地址误当 API 地址。
 */
function resolveApiBase(): string {
  const configured =
    process.env.NEXT_PUBLIC_OPEN_API_BASE_URL?.trim() || getApiBase();
  if (configured) return configured;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/** 文档示例的初始 Base URL：优先用构建期即可确定的配置地址，否则先用相对 /api/v1（hydration 后补全）。 */
function initialBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_OPEN_API_BASE_URL?.trim() || getApiBase();
  return base ? `${base}/api/v1` : '/api/v1';
}

function MethodBadge({ method }: { method: HttpMethod }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 font-mono text-[11px] font-bold ${METHOD_STYLE[method]}`}
    >
      {method}
    </span>
  );
}

/** 端点标题：方法徽章 + 路径。 */
function Endpoint({ method, path }: { method: HttpMethod; path: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-surface-cream-strong/50 px-3 py-2">
      <MethodBadge method={method} />
      <code className="font-mono text-[13px] text-ink">{path}</code>
    </div>
  );
}

/** 代码块：可选语言标签。 */
function Code({ lang, children }: { lang?: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface-card">
      {lang && (
        <div className="border-b border-hairline/60 px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          {lang}
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-ink">
        <code>{children}</code>
      </pre>
    </div>
  );
}

/** 必填状态徽章。 */
function ReqBadge({ state }: { state: ReqState }) {
  const style =
    state === '是'
      ? 'text-rose-600 bg-rose-500/10'
      : state === '条件'
        ? 'text-amber-600 bg-amber-500/10'
        : 'text-muted bg-surface-cream-strong';
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${style}`}>
      {state}
    </span>
  );
}

/** 参数表：参数 / 类型 / 必填 / 默认 / 约束 / 说明。 */
function ParamTable({ params }: { params: ParamRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-hairline bg-surface-cream-strong/40 text-muted">
            <th className="px-3 py-2 font-medium">参数</th>
            <th className="px-3 py-2 font-medium">类型</th>
            <th className="px-3 py-2 font-medium">必填</th>
            <th className="px-3 py-2 font-medium">默认</th>
            <th className="px-3 py-2 font-medium">约束</th>
            <th className="px-3 py-2 font-medium">说明</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p) => (
            <tr key={p.name} className="border-b border-hairline/50 last:border-0">
              <td className="px-3 py-2 align-top">
                <code className="font-mono text-[11px] text-ink">{p.name}</code>
              </td>
              <td className="px-3 py-2 align-top font-mono text-[11px] text-muted">{p.type}</td>
              <td className="px-3 py-2 align-top">
                <ReqBadge state={p.req} />
              </td>
              <td className="px-3 py-2 align-top font-mono text-[11px] text-muted">{p.def || '—'}</td>
              <td className="px-3 py-2 align-top text-[11px] text-muted">{p.constraints || '—'}</td>
              <td className="px-3 py-2 align-top text-ink">{p.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 通用表格（错误码等）。 */
function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-hairline bg-surface-cream-strong/40 text-muted">
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-hairline/50 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 align-top text-ink">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 小标题标签。 */
function Label({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-muted/80">{children}</p>;
}

/** 要点列表。 */
function Bullets({ items, tone = 'normal' }: { items: string[]; tone?: 'normal' | 'warn' }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-body">
          <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${tone === 'warn' ? 'bg-amber-500' : 'bg-primary/60'}`} />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-32 space-y-4">
      <h2 className="font-display border-b border-hairline/60 pb-2 text-lg font-semibold tracking-tight text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** 段落文字。 */
function P({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-muted">{children}</p>;
}

/** 内联代码。 */
function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-cream-strong px-1 py-0.5 font-mono text-[12px] text-ink">{children}</code>
  );
}

/** 提示框。 */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[12px] leading-relaxed text-ink">
      {children}
    </div>
  );
}

/** 单个排盘类型的文档卡片（精简版）。 */
function PaipanType({ spec, baseUrl }: { spec: PaipanSpec; baseUrl: string }) {
  const curl = `curl -X POST ${baseUrl}/paipan/${spec.type} \\
  -H "Authorization: Bearer fc_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '${spec.example}'`;
  return (
    <div id={spec.id} className="scroll-mt-32 space-y-3.5 rounded-xl border border-hairline bg-surface-card/40 p-4">
      <div className="space-y-2">
        <h3 className="font-display text-[15px] font-semibold text-ink">
          {spec.name}
          <span className="ml-2 font-mono text-[11px] font-normal text-muted">type = {spec.type}</span>
        </h3>
        <Endpoint method="POST" path={`/api/v1/paipan/${spec.type}`} />
        <P>{spec.summary}</P>
      </div>

      <div className="space-y-2">
        <Label>参数</Label>
        <ParamTable params={spec.params} />
      </div>

      <div className="space-y-2">
        <Label>规则</Label>
        <Bullets items={spec.rules} />
      </div>

      <div className="space-y-2">
        <Label>请求示例</Label>
        <Code lang="curl">{curl}</Code>
      </div>

      <div className="space-y-2">
        <Label>返回</Label>
        <P>{spec.returns}</P>
      </div>

      {spec.tips.length > 0 && (
        <div className="space-y-2">
          <Label>提示</Label>
          <Bullets items={spec.tips} tone="warn" />
        </div>
      )}
    </div>
  );
}

/**
 * 开发者 API 文档正文（client 组件）。
 *
 * 用顶部 4 个 tab 把内容分块（快速开始 / 排盘 / 解读 / 参考），内容已对齐后端 /api/v1 实现，
 * 但以调用方视角精简：保留参数表、规则与可跑示例，去掉内部实现细节。Base URL 取自配置的
 * API 公网地址（后端 PUBLIC_API_BASE_URL），未配置时兜底为同源 origin。
 */
export function ApiDocsContent() {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [tab, setTab] = useState<TabId>('start');

  // hydration 后补全为最终地址：配置的 API 公网地址优先，仅在同源部署时兜底为 origin。
  useEffect(() => {
    const base = resolveApiBase();
    setBaseUrl(base ? `${base}/api/v1` : '/api/v1');
  }, []);

  return (
    <AppShell requireAuth={false} wide>
      <div className="mx-auto max-w-4xl">
        {/* 头部 */}
        <header className="space-y-2 pb-5">
          <p className="font-mono text-[11px] uppercase tracking-wider text-primary">Developer API · v1</p>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">FateClaw 开放 API</h1>
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
            用 API Key 程序化调用两类能力：确定性<strong className="text-ink">排盘</strong>
            （八字 / 紫微 / 六爻 / 经占 / 梅花 / 奇门 / 六壬）与 OpenAI 兼容的{' '}
            <strong className="text-ink">AI 解读（Agent）</strong>。在
            <Link href="/settings/api-keys" className="mx-1 text-primary hover:underline">
              设置 · API Key
            </Link>
            生成你的 Key（仅会员可生成）。
          </p>
        </header>

        {/* Tab 栏 */}
        <div className="sticky top-16 z-10 mb-7 flex gap-1 border-b border-hairline/70 bg-canvas/85 backdrop-blur">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`relative px-3.5 py-2.5 text-[13px] font-medium transition-colors ${
                  active ? 'text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {t.label}
                {active && <span className="absolute inset-x-2.5 -bottom-px h-0.5 rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>

        {/* 快速开始 */}
        {tab === 'start' && (
          <div className="space-y-12">
            <Section id="start-intro" title="三步上手">
              <Bullets
                items={[
                  '生成 Key：在「设置 · API Key」创建（仅会员，最多 10 个），明文只显示一次，妥善保存。',
                  '选能力：要盘面就用「排盘」，要 AI 解读就用「解读 · Agent」。',
                  '调用：所有接口都在下面的 Base URL 下，请求头带上你的 Key 即可。',
                ]}
              />
              <Code lang="text">{`Base URL    ${baseUrl}
认证        Authorization: Bearer fc_live_xxxxxxxx
内容类型    application/json`}</Code>
              <Note>
                请求参数统一用 <C>snake_case</C>。排盘返回 <C>{`{ type, text, data }`}</C>：
                <C>text</C> 是排好的中文盘面文字，直接能展示或喂给模型；<C>data</C> 是同一盘面的结构化数据，
                字段较多、且可能随算法库升级调整——<strong className="text-ink">建议以 text 为主</strong>，
                需要 data 时做容错读取。
              </Note>
            </Section>

            <Section id="start-auth" title="认证">
              <P>在请求头携带 API Key：</P>
              <Code lang="curl">{`curl ${baseUrl}/paipan/catalog \\
  -H "Authorization: Bearer fc_live_xxxxxxxx"`}</Code>
              <P>
                Key 无效或过期返回 401；会员过期返回 403（续费后自动恢复）；积分欠费返回 402。
                完整错误码见「参考」。
              </P>
            </Section>

            <Section id="start-example" title="最小示例">
              <P>一次八字排盘（其余排盘换 URL 与参数即可）：</P>
              <Code lang="curl">{`curl -X POST ${baseUrl}/paipan/bazi \\
  -H "Authorization: Bearer fc_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"solar_date":"2000-08-16","hour":14,"gender":"male"}'`}</Code>
              <Code lang="json">{`{
  "type": "bazi",
  "text": "八字排盘（系统排盘结果）……",
  "data": { /* 结构化盘面 */ }
}`}</Code>
            </Section>
          </div>
        )}

        {/* 排盘 */}
        {tab === 'paipan' && (
          <div className="space-y-8">
            <div className="space-y-4">
              <P>
                排盘是本地确定性计算，<strong className="text-ink">不计费</strong>（但仍需有效会员、账户不欠费）。
                每个排盘都返回 <C>{`{ type, text, data }`}</C>，参数统一 <C>snake_case</C>。
              </P>
              <Endpoint method="GET" path="/api/v1/paipan/catalog" />
              <P>列出全部排盘类型及其参数 Schema，可用来动态获取参数定义。</P>
              <div className="flex flex-wrap gap-1.5">
                {PAIPAN_SPECS.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    className="rounded-full border border-hairline bg-surface-card px-3 py-1 text-[12px] text-muted transition-colors hover:border-primary/40 hover:text-ink"
                  >
                    {s.name}
                  </a>
                ))}
              </div>
            </div>
            <div className="space-y-5">
              {PAIPAN_SPECS.map((spec) => (
                <PaipanType key={spec.id} spec={spec} baseUrl={baseUrl} />
              ))}
            </div>
          </div>
        )}

        {/* 解读 · Agent */}
        {tab === 'agent' && (
          <div className="space-y-12">
            <Section id="agent-chat" title="AI 解读（OpenAI 兼容）">
              <Endpoint method="POST" path="/api/v1/chat/completions" />
              <P>
                兼容 OpenAI Chat Completions，可直接用 OpenAI SDK 改 <C>base_url</C> 调用。要让 AI 解读一张盘，
                把排盘返回的内容放进 <C>fateclaw.board</C> 即可（OpenAI SDK 经 <C>extra_body</C> 传 <C>fateclaw</C>）。
              </P>
              <Note>
                <strong className="text-ink">支持多轮对话：</strong>和 OpenAI 一样，上下文由本次 <C>messages</C> 决定（服务端不存历史）。
                <strong className="text-ink">最后一条 user</strong> 是本轮提问，它前面的 user / assistant 轮会作为对话历史，
                <strong className="text-ink">第一条 system</strong> 作为人设。响应的 <C>usage</C> 为真实 token 数；
                <C>stream=true</C> 走 SSE 流式（OpenAI chunk 格式）。
              </Note>

              <Label>请求参数</Label>
              <ParamTable params={AGENT_PARAMS} />

              <div className="space-y-2">
                <Label>解读一张盘</Label>
                <P>
                  把 <C>/api/v1/paipan/:type</C> 的返回填进 <C>board</C>：优先用 <C>text</C> 作为解读内容，
                  <C>text</C> 缺失时才用 <C>data</C>；用户问题取自最后一条 user 消息。
                </P>
              </div>

              <P>示例：Python（openai SDK）</P>
              <Code lang="python">{`from openai import OpenAI

client = OpenAI(base_url="${baseUrl}", api_key="fc_live_xxxxxxxx")

resp = client.chat.completions.create(
    model="<official-model-key>",          # 来自 GET /api/v1/models
    messages=[
        {"role": "system", "content": "你是一位严谨的命理解读师。"},
        {"role": "user", "content": "请帮我解读这张盘的事业走向。"},
    ],
    extra_body={
        "fateclaw": {
            "thinking_level": "high",       # off|minimal|low|medium|high|xhigh，默认 medium
            "board": {                       # 把 /api/v1/paipan 的返回放进来
                "type": "bazi",
                "text": "<来自 /api/v1/paipan/bazi 的 text>",
            },
        }
    },
)
print(resp.choices[0].message.content)`}</Code>

              <P>示例：curl</P>
              <Code lang="curl">{`curl -X POST ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer fc_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "<official-model-key>",
    "messages": [
      {"role": "system", "content": "你是一位严谨的命理解读师。"},
      {"role": "user", "content": "请帮我解读这张盘的事业走向。"}
    ],
    "fateclaw": { "thinking_level": "high" }
  }'`}</Code>

              <Label>返回</Label>
              <P>
                标准 OpenAI <C>chat.completion</C>：解读正文在 <C>choices[0].message.content</C>。
              </P>
            </Section>

            <Section id="agent-models" title="模型">
              <Endpoint method="GET" path="/api/v1/models" />
              <P>
                返回可用的官方模型（OpenAI 兼容 <C>list</C> 结构）。调用解读时 <C>model</C> 直接传返回的 <C>id</C>。
              </P>
              <Code lang="json">{`{
  "object": "list",
  "data": [
    { "id": "<model_key>", "object": "model", "owned_by": "fateclaw" }
  ]
}`}</Code>
              <Note>列表可能包含暂时不可用的模型；用它调用时若不可用会返回 <C>model_not_found</C>。</Note>
            </Section>
          </div>
        )}

        {/* 参考 */}
        {tab === 'reference' && (
          <div className="space-y-12">
            <Section id="ref-billing" title="计费">
              <Bullets
                items={[
                  '排盘免费：所有排盘接口不扣积分（但仍需有效会员、账户不欠费）。',
                  '解读按 token 计费：按所用官方模型的输入 / 输出单价从积分扣，口径与站内 AI 对话一致。',
                  '账户欠费会拦截所有请求（402）；会员过期会拦截（403），续费后自动恢复。',
                  '只支持平台官方模型，不支持自带密钥（BYOK）。',
                ]}
              />
            </Section>

            <Section id="ref-ratelimit" title="限流">
              <P>
                每个 API Key 默认 <strong className="text-ink">60 次 / 分钟</strong>，超出返回 429，并在{' '}
                <C>Retry-After</C> 头给出需等待的秒数。此外，连续鉴权失败会临时限制来源 IP。
              </P>
            </Section>

            <Section id="ref-errors" title="错误码">
              <P>所有错误统一返回如下结构（<C>param</C> 恒为 <C>null</C>）：</P>
              <Code lang="json">{`{
  "error": {
    "message": "账户积分欠费，请补充积分后继续调用",
    "type": "insufficient_quota",
    "code": "insufficient_quota",
    "param": null
  }
}`}</Code>
              <Table
                headers={['状态码', 'code', 'type', '含义']}
                rows={ERROR_CODES.map((e) => [
                  <span key="s" className="font-mono font-medium">{e.status}</span>,
                  <C key="c">{e.code}</C>,
                  <span key="t" className="font-mono text-[11px] text-muted">{e.type}</span>,
                  <span key="w" className="text-muted">{e.when}</span>,
                ])}
              />
              <Note>
                排盘的<strong className="text-ink">参数问题</strong>是 400，<strong className="text-ink">执行阶段</strong>
                的问题（比如时间非法、漏传该方式必需的参数）是 500；判断具体原因看 <C>code</C> 字段即可。
              </Note>
            </Section>
          </div>
        )}
      </div>
    </AppShell>
  );
}
