'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';

import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Code2,
  Link2,
  Search,
  X,
} from 'lucide-react';

import { DeveloperShell } from '@/components/developer/developer-shell';
import { CodeBlock, CopyButton } from '@/components/developer/code-block';
import { useOpenApiBase } from '@/features/api-keys/use-open-api-base';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

const METHOD_STYLE: Record<HttpMethod, string> = {
  GET: 'text-chart-wood bg-success/10',
  POST: 'text-primary bg-primary/10',
  DELETE: 'text-error bg-error/10',
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
    summary:
      '根据阳历生日、出生小时和性别，算出四柱、大运、逐年流年和格局。可用 include 只取其中几部分。',
    params: [
      {
        name: 'solar_date',
        type: 'string',
        req: '是',
        def: '',
        constraints: 'YYYY-MM-DD（例 2000-08-16）',
        desc: '阳历出生日期。',
      },
      {
        name: 'hour',
        type: 'integer',
        req: '是',
        def: '',
        constraints: '0–23（24 小时制）',
        desc: '出生小时，允许 0。',
      },
      {
        name: 'minute',
        type: 'integer',
        req: '否',
        def: '0',
        constraints: '0–59',
        desc: '出生分钟，影响早晚子时与起运精度。',
      },
      {
        name: 'gender',
        type: 'string',
        req: '是',
        def: '',
        constraints: '男 | 女 | male | female',
        desc: '性别（male/female 会归一化为 男/女）。',
      },
      {
        name: 'zishi_mode',
        type: 'string',
        req: '否',
        def: 'early',
        constraints: 'early | late',
        desc: '子时切换：early=23:00 起算次日，late=算当日。',
      },
      {
        name: 'child_limit_mode',
        type: 'string',
        req: '否',
        def: 'default',
        constraints: 'default | china95 | lunar_sect1 | lunar_sect2',
        desc: '起运（童限）算法。',
      },
      {
        name: 'include',
        type: 'array',
        req: '否',
        def: '全部',
        constraints: 'items ∈ bazi | fortune | pattern',
        desc: '要返回的部分，省略 = 全返回。',
      },
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
    returns:
      'text 是中文盘面（命盘概要、四柱明细、起运、大运小运、逐年流年），可直接展示或交给模型解读。',
    tips: [
      'include 只填 pattern 时不会有文字盘面（text 为空），想要文字至少带上 bazi 或 fortune。',
      '逐年流年可能上百条，响应体较大。',
    ],
  },
  {
    id: 'paipan-ziwei',
    type: 'ziwei',
    name: '紫微斗数排盘',
    summary:
      '根据阳历生日、出生小时和性别生成十二宫星盘，可选叠加大限 / 流年等运盘。',
    params: [
      {
        name: 'solar_date',
        type: 'string',
        req: '是',
        def: '',
        constraints: 'YYYY-MM-DD',
        desc: '阳历出生日期。',
      },
      {
        name: 'hour',
        type: 'integer',
        req: '是',
        def: '',
        constraints: '0–23',
        desc: '出生小时。',
      },
      {
        name: 'minute',
        type: 'integer',
        req: '否',
        def: '0',
        constraints: '0–59',
        desc: '目前不影响排盘结果。',
      },
      {
        name: 'gender',
        type: 'string',
        req: '是',
        def: '',
        constraints: '男 | 女 | male | female',
        desc: '性别。',
      },
      {
        name: 'fix_leap',
        type: 'boolean',
        req: '否',
        def: 'true',
        constraints: '—',
        desc: '是否修正闰月。',
      },
      {
        name: 'day_divide',
        type: 'string',
        req: '否',
        def: 'forward',
        constraints: 'forward | current',
        desc: '晚子时换日规则。',
      },
      {
        name: 'year_divide',
        type: 'string',
        req: '否',
        def: 'normal',
        constraints: 'normal | exact',
        desc: '年干支分界：农历新年 / 立春。',
      },
      {
        name: 'horoscope_divide',
        type: 'string',
        req: '否',
        def: 'normal',
        constraints: 'normal | exact',
        desc: '运限分界：农历新年 / 立春。',
      },
      {
        name: 'age_divide',
        type: 'string',
        req: '否',
        def: 'normal',
        constraints: 'normal | birthday',
        desc: '小限分界：自然年 / 生日。',
      },
      {
        name: 'horoscope',
        type: 'object',
        req: '否',
        def: '',
        constraints: '{ date, scopes }',
        desc: '可选：叠加运盘，填了 date 才生效。',
      },
      {
        name: 'horoscope.date',
        type: 'string',
        req: '条件',
        def: '',
        constraints: 'YYYY-MM-DD',
        desc: '运盘目标日期。',
      },
      {
        name: 'horoscope.scopes',
        type: 'array',
        req: '否',
        def: '[decadal, yearly]',
        constraints: 'decadal|age|yearly|monthly|daily|hourly',
        desc: '要返回的运盘尺度。',
      },
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
    returns:
      'text 是中文星盘（命盘概要、生年四化、十二宫、流年四化，及叠加的运盘）。',
    tips: [
      'horoscope.date 漏填不会报错，但运盘不会叠加，容易误以为生效了。',
      'minute 目前不影响排盘结果。',
    ],
  },
  {
    id: 'paipan-iching',
    type: 'iching',
    name: '六爻排盘',
    summary:
      '六爻纳甲排盘。按起卦方式生成本卦 / 变卦 / 互卦、六亲六兽、世应、伏神、神煞等。',
    params: [
      {
        name: 'method',
        type: 'string',
        req: '否',
        def: 'dayan',
        constraints: 'dayan | lueshifa | manual | three | array | time',
        desc: '起卦方式。',
      },
      {
        name: 'yao',
        type: 'string',
        req: '条件',
        def: '',
        constraints: '6 位爻码，每位 6/7/8/9，例 "789678"',
        desc: 'method=manual 时必填。',
      },
      {
        name: 'numbers',
        type: 'array',
        req: '条件',
        def: '',
        constraints: 'three=3 个数、array≥2 个数',
        desc: 'method=three / array 时必填。',
      },
      {
        name: 'datetime',
        type: 'string',
        req: '否',
        def: '当前时间',
        constraints: '"YYYY-MM-DD HH:mm"',
        desc: 'method=time 起卦用；array 用其小时定起卦时辰；其余方式作四柱/月建/旬空。',
      },
    ],
    rules: [
      'method 决定要带哪些参数：manual 需 yao；three / array 需 numbers；time 用 datetime；dayan / lueshifa 直接随机起卦。',
    ],
    example: `{
  "method": "manual",
  "yao": "789678"
}`,
    returns:
      'text 是完整中文卦盘（起卦概要、卦象关系、本卦六爻、伏神、神煞）。',
    tips: [
      '默认的 dayan 和 lueshifa 是随机起卦，每次结果都不同；要可复现请用 manual / three / array / time。',
    ],
  },
  {
    id: 'paipan-jingzhan',
    type: 'jingzhan',
    name: '经占排盘',
    summary:
      '经占排盘。和六爻用同一套参数，但只解卦辞与动爻爻辞，不含纳甲、六亲、世应、神煞。',
    params: [
      {
        name: 'method',
        type: 'string',
        req: '否',
        def: 'dayan',
        constraints: 'dayan | lueshifa | manual | three | array | time',
        desc: '起卦方式。',
      },
      {
        name: 'yao',
        type: 'string',
        req: '条件',
        def: '',
        constraints: '6 位爻码 6/7/8/9',
        desc: 'method=manual 时必填。',
      },
      {
        name: 'numbers',
        type: 'array',
        req: '条件',
        def: '',
        constraints: 'three=3 个数、array≥2 个数',
        desc: 'method=three / array 时必填。',
      },
      {
        name: 'datetime',
        type: 'string',
        req: '否',
        def: '当前时间',
        constraints: '"YYYY-MM-DD HH:mm"',
        desc: 'method=time 起卦用；array 用其小时定起卦时辰。',
      },
    ],
    rules: ['method 决定参数：同六爻；不带任何参数则按随机大衍起卦。'],
    example: `{
  "method": "manual",
  "yao": "789678"
}`,
    returns: 'text 是卦辞 / 爻辞解读（起卦概要、卦象、经文取辞、爻值摘要）。',
    tips: ['和六爻参数相同但侧重不同：经占只看卦辞、爻辞，选类型时别混了。'],
  },
  {
    id: 'paipan-meihua',
    type: 'meihua',
    name: '梅花易数排盘',
    summary:
      '梅花易数排盘。按时间 / 报数 / 指定上下卦三种方式起卦，给出本卦、互卦、变卦、错卦、综卦及体用生克。',
    params: [
      {
        name: 'method',
        type: 'string',
        req: '否',
        def: 'time',
        constraints: 'time | counts | trigrams',
        desc: '起卦方式，决定要带哪些参数。',
      },
      {
        name: 'datetime',
        type: 'string',
        req: '否',
        def: '当前时间',
        constraints: '"YYYY-MM-DD HH:mm"',
        desc: 'method=time 可选，不传用当前时间。',
      },
      {
        name: 'count_method',
        type: 'string',
        req: '否',
        def: 'number',
        constraints: 'number | word | sound | object | direction | external',
        desc: 'method=counts 的取数来源标注，不影响起卦结果。',
      },
      {
        name: 'upper',
        type: 'integer',
        req: '条件',
        def: '',
        constraints: '整数',
        desc: 'method=counts 必填：上卦取数。',
      },
      {
        name: 'lower',
        type: 'integer',
        req: '条件',
        def: '',
        constraints: '整数',
        desc: 'method=counts 必填：下卦取数。',
      },
      {
        name: 'moving',
        type: 'integer',
        req: '否',
        def: '',
        constraints: '整数',
        desc: 'method=counts 可选动爻；不传由 upper+lower 推导。',
      },
      {
        name: 'upper_trigram',
        type: 'string',
        req: '条件',
        def: '',
        constraints: '乾 兑 离 震 巽 坎 艮 坤',
        desc: 'method=trigrams 必填：上卦。',
      },
      {
        name: 'lower_trigram',
        type: 'string',
        req: '条件',
        def: '',
        constraints: '乾 兑 离 震 巽 坎 艮 坤',
        desc: 'method=trigrams 必填：下卦。',
      },
      {
        name: 'moving_line',
        type: 'integer',
        req: '条件',
        def: '',
        constraints: '1–6',
        desc: 'method=trigrams 必填：动爻。',
      },
      {
        name: 'label',
        type: 'string',
        req: '否',
        def: '',
        constraints: '—',
        desc: '可选备注，会回显在盘面。',
      },
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
    summary:
      '奇门遁甲排盘（拆补法）。按指定时间或当前时间起局，给出九宫、值符值使、八门九星、天地盘、马星等。',
    params: [
      {
        name: 'solar_date',
        type: 'string',
        req: '否',
        def: '',
        constraints: 'YYYY-MM-DD',
        desc: '阳历日期，不传用当前时间。',
      },
      {
        name: 'hour',
        type: 'integer',
        req: '否',
        def: '',
        constraints: '0–23',
        desc: '小时，不传用当前时间。',
      },
      {
        name: 'minute',
        type: 'integer',
        req: '否',
        def: '0',
        constraints: '0–59',
        desc: '与 solar_date/hour 一起传指定时间时生效。',
      },
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
    summary:
      '大六壬排盘。按当前时间、指定时间或随机时辰起一课，返回天地盘、四课、三传、建除和神煞。',
    params: [
      {
        name: 'solar_date',
        type: 'string',
        req: '否',
        def: '',
        constraints: 'YYYY-MM-DD',
        desc: '阳历日期，不传用当前时间。',
      },
      {
        name: 'hour',
        type: 'integer',
        req: '否',
        def: '',
        constraints: '0–23',
        desc: '小时，通常与 solar_date 一起传。',
      },
      {
        name: 'minute',
        type: 'integer',
        req: '否',
        def: '0',
        constraints: '0–59',
        desc: '与 solar_date/hour 一起传时生效。',
      },
      {
        name: 'random_number',
        type: 'integer',
        req: '否',
        def: '',
        constraints: '整数',
        desc: '随机种子，固定它可让随机起课可复现。',
      },
      {
        name: 'time_mode',
        type: 'string',
        req: '否',
        def: '',
        constraints: 'now | custom | random',
        desc: '起课模式标识；random 时只传 hour 也不报错。',
      },
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

/** Session creation configures persona, board, and skills; model execution is platform-managed. */
const SESSION_CREATE_PARAMS: ParamRow[] = [
  {
    name: 'model',
    type: 'string',
    req: '否',
    def: '当前官方模型',
    constraints: '如填写，须为当前官方模型标识',
    desc: '省略即可使用后台统一配置的官方模型。',
  },
  {
    name: 'system',
    type: 'string',
    req: '否',
    def: '',
    constraints: '—',
    desc: '人设：作为附加的角色/口吻层；不会覆盖平台核心指令。',
  },
  {
    name: 'fateclaw',
    type: 'object',
    req: '否',
    def: '',
    constraints: '—',
    desc: 'FateClaw 扩展：skills / board。',
  },
  {
    name: 'fateclaw.skills',
    type: 'array',
    req: '否',
    def: '',
    constraints: 'UUID[]',
    desc: '开启的技能：skill id（UUID），用 GET /api/v1/skills 获取；无权或未启用的会被忽略。',
  },
  {
    name: 'fateclaw.board',
    type: 'object',
    req: '否',
    def: '',
    constraints: '{ type?, text?, data? }',
    desc: '排盘结果，通常回填 /api/v1/paipan 的输出；只需在建会话时传一次，之后每轮自动带上。',
  },
  {
    name: 'fateclaw.board.type',
    type: 'string',
    req: '否',
    def: 'board',
    constraints: '—',
    desc: '盘面类型。',
  },
  {
    name: 'fateclaw.board.text',
    type: 'string',
    req: '否',
    def: '',
    constraints: '—',
    desc: '中文盘面文本（来自 /api/v1/paipan 的 text）。',
  },
  {
    name: 'fateclaw.board.data',
    type: 'unknown',
    req: '否',
    def: '',
    constraints: '任意 JSON',
    desc: '结构化盘面；仅当 text 缺失时兜底使用。',
  },
];

/** 发消息（POST /sessions/:sid/messages）请求参数：每轮只发本轮文本。 */
const SESSION_MESSAGE_PARAMS: ParamRow[] = [
  {
    name: 'content',
    type: 'string',
    req: '是',
    def: '',
    constraints: '非空',
    desc: '本轮提问；历史与盘面由会话记着，无需重发。',
  },
];

/** 错误码（调用方视角）。 */
const ERROR_CODES: Array<{
  status: string;
  code: string;
  type: string;
  when: string;
}> = [
  {
    status: '401',
    code: 'invalid_api_key',
    type: 'invalid_request_error',
    when: 'Key 缺失、格式不对、无效、已吊销或已过期',
  },
  {
    status: '402',
    code: 'insufficient_quota',
    type: 'insufficient_quota',
    when: '积分欠费，需要补充积分',
  },
  {
    status: '403',
    code: 'PAIPAN.SKILL_NOT_ENABLED',
    type: 'invalid_request_error',
    when: '该排盘类型未对你启用',
  },
  {
    status: '404',
    code: 'unknown_paipan_type',
    type: 'invalid_request_error',
    when: '排盘类型不存在',
  },
  {
    status: '400',
    code: 'PAIPAN.PARAM_INVALID',
    type: 'invalid_request_error',
    when: '排盘参数错误（缺必填、类型 / 枚举 / 范围不对）',
  },
  {
    status: '500',
    code: 'PAIPAN.EXECUTION_FAILED',
    type: 'invalid_request_error',
    when: '排盘执行出错（如时间非法、漏传该方式必需的参数）',
  },
  {
    status: '400',
    code: 'invalid_request',
    type: 'invalid_request_error',
    when: '请求体有误（缺字段、类型不对等）',
  },
  {
    status: '400',
    code: 'model_not_found',
    type: 'invalid_request_error',
    when: '官方模型暂不可用，或 model 不是当前官方模型标识',
  },
  {
    status: '404',
    code: 'session_not_found',
    type: 'invalid_request_error',
    when: '会话不存在、无权访问、已删除或已过期',
  },
  {
    status: '409',
    code: 'session_busy',
    type: 'invalid_request_error',
    when: '同一会话上一条消息仍在处理中（每会话需串行发消息）',
  },
  {
    status: '502',
    code: 'agent_error',
    type: 'api_error',
    when: 'Agent 执行失败',
  },
  {
    status: '429',
    code: 'rate_limit_exceeded',
    type: 'rate_limit_exceeded',
    when: '调用过于频繁（带 Retry-After 头）',
  },
  {
    status: '500',
    code: 'internal_error',
    type: 'api_error',
    when: '服务器内部错误',
  },
  {
    status: '503',
    code: 'service_unavailable',
    type: 'api_error',
    when: '限流服务暂不可用，请稍后重试',
  },
];

const DOC_GROUPS = [
  {
    id: 'start',
    label: '快速开始',
    sections: [
      {
        id: 'start-intro',
        label: '概览与接入',
        keywords: 'API Key Base URL 接入 认证',
      },
      {
        id: 'start-auth',
        label: '身份认证',
        keywords: 'Authorization Bearer 401 402 环境变量',
      },
      {
        id: 'start-example',
        label: '第一个请求',
        keywords: 'curl Python JavaScript 示例 八字 bazi',
      },
      {
        id: 'start-flow',
        label: '排盘到 AI 解读',
        keywords: '完整流程 会话 session 多轮',
      },
    ],
  },
  {
    id: 'paipan',
    label: '排盘 API',
    sections: [
      {
        id: 'paipan-overview',
        label: '排盘概览',
        keywords: 'catalog schema 排盘类型 免费',
      },
      ...PAIPAN_SPECS.map((spec) => ({
        id: spec.id,
        label: spec.name,
        keywords: `${spec.type} /paipan/${spec.type} /api/v1/paipan/${spec.type} ${spec.summary} ${spec.params.map((param) => param.name).join(' ')}`,
      })),
    ],
  },
  {
    id: 'agent',
    label: 'AI 解读 API',
    sections: [
      {
        id: 'agent-chat',
        label: '会话与消息',
        keywords:
          'POST GET DELETE /sessions /api/v1/sessions messages content system board 多轮 Python usage token',
      },
      {
        id: 'agent-models',
        label: '模型',
        keywords: 'GET /models /api/v1/models model 官方',
      },
      {
        id: 'agent-skills',
        label: '技能',
        keywords: 'GET /skills /api/v1/skills UUID 订阅',
      },
    ],
  },
  {
    id: 'reference',
    label: '参考',
    sections: [
      {
        id: 'ref-billing',
        label: '计费说明',
        keywords: '积分 token 消耗 会员 价格 免费',
      },
      {
        id: 'ref-ratelimit',
        label: '请求限流',
        keywords: '60 429 Retry-After 并发 rate limit',
      },
      {
        id: 'ref-errors',
        label: '错误码',
        keywords: ERROR_CODES.map(
          (error) => `${error.status} ${error.code} ${error.when}`,
        ).join(' '),
      },
    ],
  },
] as const;
type TabId = (typeof DOC_GROUPS)[number]['id'];

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
      <code className="min-w-0 break-all font-mono text-xs text-ink">
        {path}
      </code>
    </div>
  );
}

function Code({ lang, children }: { lang?: string; children: string }) {
  return <CodeBlock language={lang}>{children}</CodeBlock>;
}

/** 必填状态徽章。 */
function ReqBadge({ state }: { state: ReqState }) {
  const style =
    state === '是'
      ? 'text-primary bg-primary/10'
      : state === '条件'
        ? 'text-warning bg-warning/10'
        : 'text-muted bg-surface-cream-strong';
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${style}`}
    >
      {state === '是' ? '必填' : state === '否' ? '可选' : '条件必填'}
    </span>
  );
}

function ParamTable({ params }: { params: ParamRow[] }) {
  return (
    <div className="relative overflow-x-auto rounded-xl border border-hairline bg-surface-raised">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
        <caption className="sr-only">
          请求参数、类型、必填条件、默认值与约束
        </caption>
        <thead className="border-b border-hairline bg-surface-soft/60 text-[11px] text-muted">
          <tr>
            {['参数', '类型', '必填', '说明'].map((label) => (
              <th key={label} scope="col" className="px-4 py-3 font-normal">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline/60">
          {params.map((param) => (
            <tr key={param.name}>
              <th
                scope="row"
                className="px-4 py-4 align-top font-mono text-[11px] font-medium text-ink"
              >
                {param.name}
              </th>
              <td className="px-4 py-4 align-top font-mono text-[11px] text-muted">
                {param.type}
              </td>
              <td className="whitespace-nowrap px-4 py-4 align-top">
                <ReqBadge state={param.req} />
              </td>
              <td className="min-w-56 px-4 py-4 align-top text-body">
                <p className="leading-6">{param.desc}</p>
                {param.constraints && param.constraints !== '—' && (
                  <p className="mt-1 break-words font-mono text-[10px] leading-5 text-muted">
                    {param.constraints}
                  </p>
                )}
                {param.def && (
                  <p className="mt-1 text-[10px] text-muted">
                    默认：<code className="font-mono">{param.def}</code>
                  </p>
                )}
              </td>
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
    <div className="relative overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
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
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted/80">
      {children}
    </p>
  );
}

/** 要点列表。 */
function Bullets({
  items,
  tone = 'normal',
}: {
  items: string[];
  tone?: 'normal' | 'warn';
}) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-xs leading-6 text-body">
          <span
            className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${tone === 'warn' ? 'bg-warning' : 'bg-primary/60'}`}
          />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 space-y-5">
      <h2 className="group flex items-center gap-2 border-b border-hairline pb-4 text-xl font-medium text-ink">
        {title}
        <a
          href={`#${id}`}
          aria-label={`链接到${title}`}
          className="rounded p-1 text-muted-soft opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <Link2 size={14} />
        </a>
      </h2>
      {children}
    </section>
  );
}

/** 段落文字。 */
function P({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-7 text-body">{children}</p>;
}

/** 内联代码。 */
function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-cream-strong px-1 py-0.5 font-mono text-[12px] text-ink">
      {children}
    </code>
  );
}

/** 提示框。 */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-[12px] leading-relaxed text-ink">
      {children}
    </div>
  );
}

/** 流程步骤块：左侧序号徽标 + 标题 + 子内容，用于「完整流程」把多接口调用分步散开展示。 */
function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="relative pl-11">
      <span className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-[13px] font-semibold text-primary">
        {n}
      </span>
      <h4 className="mb-2 text-[14px] font-semibold text-ink">{title}</h4>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

/** 单个排盘类型的文档卡片（精简版）。 */
function PaipanType({ spec, baseUrl }: { spec: PaipanSpec; baseUrl: string }) {
  const curl = `curl --fail-with-body --max-time 180 -X POST ${baseUrl}/paipan/${spec.type} \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${spec.example}'`;
  return (
    <div
      id={spec.id}
      className="scroll-mt-24 space-y-5 rounded-xl border border-hairline bg-surface-raised/50 p-4 sm:p-6"
    >
      <div className="space-y-2">
        <h3 className="text-lg font-medium text-ink">
          {spec.name}
          <span className="ml-2 font-mono text-[11px] font-normal text-muted">
            type = {spec.type}
          </span>
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

export function ApiDocsContent() {
  const baseUrl = useOpenApiBase();
  const [tab, setTab] = useState<TabId>('start');
  const [section, setSection] = useState('start-intro');
  const [search, setSearch] = useState('');
  const scrollPending = useRef(false);

  useEffect(() => {
    const followHash = () => {
      const id = window.location.hash.slice(1) || 'start-intro';
      const group = DOC_GROUPS.find((item) =>
        item.sections.some((entry) => entry.id === id),
      );
      if (!group) return;
      scrollPending.current = Boolean(window.location.hash);
      setTab(group.id);
      setSection(id);
    };
    followHash();
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  useEffect(() => {
    if (!scrollPending.current) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(section)?.scrollIntoView({ block: 'start' });
      scrollPending.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, section]);

  const query = search.trim().toLowerCase();
  const groups = DOC_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((entry) =>
      `${group.label} ${entry.label} ${entry.keywords}`
        .toLowerCase()
        .includes(query),
    ),
  })).filter((group) => group.sections.length > 0);
  const currentGroup = DOC_GROUPS.find((group) => group.id === tab)!;

  return (
    <DeveloperShell
      active="docs"
      title="API 文档"
      description="从第一个请求到多轮 AI 解读，查阅接入指南、接口参数与代码示例。"
      actions={
        <Link
          href="/settings/api-keys"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-hairline bg-surface-raised px-4 text-xs text-ink hover:border-primary/40"
        >
          管理 API Key
          <ArrowUpRight size={14} />
        </Link>
      }
    >
      <div className="grid items-start gap-8 lg:grid-cols-[184px_minmax(0,1fr)] xl:gap-10">
        <aside className="min-w-0 lg:sticky lg:top-8" aria-label="文档目录">
          <label className="flex h-10 items-center gap-2 rounded-lg border border-hairline bg-surface-raised px-3">
            <Search size={14} className="shrink-0 text-muted" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索接口、参数…"
              aria-label="搜索 API 文档目录"
              className="min-w-0 w-full bg-transparent text-xs text-ink outline-none placeholder:text-muted-soft"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="清除文档搜索"
                className="flex h-7 w-7 shrink-0 items-center justify-center text-muted"
              >
                <X size={12} />
              </button>
            )}
          </label>
          <div className="mt-3 lg:hidden">
            <select
              aria-label="选择文档章节"
              value={section}
              onChange={(event) => {
                window.location.hash = event.target.value;
              }}
              className="h-10 w-full rounded-lg border border-hairline bg-canvas px-3 text-xs text-ink"
            >
              {DOC_GROUPS.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.sections.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <nav
            aria-label="API 文档章节"
            className={`${search ? 'block' : 'hidden'} mt-6 max-h-72 space-y-6 overflow-y-auto pr-1 lg:block lg:max-h-[calc(100dvh-9rem)]`}
          >
            {groups.length === 0 && (
              <p role="status" className="px-2 text-xs leading-6 text-muted">
                没有匹配的章节，试试接口名或参数名。
              </p>
            )}
            {groups.map((group) => (
              <div key={group.id}>
                <p className="mb-2 px-2 text-[10px] font-medium text-muted">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.sections.map((entry) => (
                    <li key={entry.id}>
                      <a
                        href={`#${entry.id}`}
                        onClick={() => setSearch('')}
                        aria-current={
                          section === entry.id ? 'location' : undefined
                        }
                        className={`flex min-h-9 items-center justify-between gap-1 rounded-md px-2 text-xs transition-colors ${section === entry.id ? 'bg-primary/8 font-medium text-primary' : 'text-body hover:bg-surface-soft hover:text-ink'}`}
                      >
                        {entry.label}
                        {section === entry.id && (
                          <ChevronRight size={12} className="shrink-0" />
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <article className="min-w-0">
          <div className="mb-7 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-hairline bg-surface-soft/50 px-3 py-2.5">
            <Code2 size={14} className="shrink-0 text-primary" />
            <span className="shrink-0 text-[10px] text-muted">Base URL</span>
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink">
              {baseUrl}
            </code>
            <CopyButton value={baseUrl} label="复制地址" />
          </div>
          <div className="mb-7 flex items-center gap-2 text-[11px] text-muted">
            <BookOpen size={13} />
            API 文档
            <ChevronRight size={11} />
            <span className="text-ink">{currentGroup.label}</span>
          </div>

          {/* 快速开始 */}
          {tab === 'start' && (
            <div className="space-y-12">
              <Section id="start-intro" title="三步上手">
                <Bullets
                  items={[
                    '生成 Key：在「开发者中心 · API Key」创建（仅会员，最多 10 个），明文只显示一次，妥善保存。',
                    '选能力：要盘面就用「排盘」，要 AI 解读就用「解读 · Agent」。',
                    '调用：所有接口都在下面的 Base URL 下，请求头带上你的 Key 即可。',
                  ]}
                />
                <Code lang="text">{`Base URL    ${baseUrl}
认证        Authorization: Bearer $FATECLAW_API_KEY
内容类型    application/json`}</Code>
                <Note>
                  请求参数统一用 <C>snake_case</C>。排盘返回{' '}
                  <C>{`{ type, text, data }`}</C>：<C>text</C>{' '}
                  是排好的中文盘面文字，直接能展示或喂给模型；<C>data</C>{' '}
                  是同一盘面的结构化数据， 字段较多、且可能随算法库升级调整——
                  <strong className="text-ink">建议以 text 为主</strong>， 需要
                  data 时做容错读取。
                </Note>
              </Section>

              <Section id="start-auth" title="认证">
                <P>
                  将密钥保存到服务端的 <C>FATECLAW_API_KEY</C>{' '}
                  环境变量，再通过请求头携带。不要把密钥写入浏览器代码或公开仓库。
                </P>
                <Code lang="curl">{`curl --fail-with-body --max-time 60 ${baseUrl}/paipan/catalog \\
  -H "Authorization: Bearer $FATECLAW_API_KEY"`}</Code>
                <P>
                  Key 无效或过期返回 401；积分欠费返回 402。会员到期后，已有有效
                  Key 仍可调用，解读按普通用户价格计费。完整错误码见「参考」。
                </P>
              </Section>

              <Section id="start-example" title="最小示例">
                <P>一次八字排盘（其余排盘换 URL 与参数即可）：</P>
                <Code lang="curl">{`curl --fail-with-body --max-time 180 -X POST ${baseUrl}/paipan/bazi \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"solar_date":"2000-08-16","hour":14,"gender":"male"}'`}</Code>
                <Code lang="json">{`{
  "type": "bazi",
  "text": "八字排盘（系统排盘结果）……",
  "data": {}
}`}</Code>
              </Section>

              <Section id="start-flow" title="完整流程：排盘 → 解读">
                <P>
                  把确定性<strong className="text-ink">排盘</strong>和 AI{' '}
                  <strong className="text-ink">解读</strong>
                  串成一次完整调用，照抄即可跑通。盘面只在建会话时传一次，之后多轮自动带上。
                </P>
                <div className="space-y-7">
                  <Step n={1} title="生成 API Key">
                    <P>
                      在「开发者中心 · API Key」生成（仅会员，最多 10
                      个）。明文只显示一次，将密钥设为服务端的{' '}
                      <C>FATECLAW_API_KEY</C> 环境变量后运行下方示例。
                    </P>
                  </Step>

                  <Step n={2} title="排盘（拿盘面）">
                    <Code lang="curl">{`curl --fail-with-body --max-time 180 -X POST ${baseUrl}/paipan/bazi \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"solar_date":"2000-08-16","hour":14,"gender":"male"}'`}</Code>
                    <Code lang="json">{`{ "type": "bazi", "text": "八字排盘（系统排盘结果）……", "data": {} }`}</Code>
                    <P>
                      留下其中的 <C>text</C>，下一步作为盘面传入。
                    </P>
                  </Step>

                  <Step n={3} title="（可选）查可用技能">
                    <Code lang="curl">{`curl --fail-with-body --max-time 60 ${baseUrl}/skills \\
  -H "Authorization: Bearer $FATECLAW_API_KEY"`}</Code>
                    <P>
                      取返回 <C>data[].id</C> 填入下一步的{' '}
                      <C>fateclaw.skills</C>
                      ；没有技能可跳过这步。
                    </P>
                  </Step>

                  <Step n={4} title="建会话（盘面 / 技能）">
                    <Code lang="curl">{`curl --fail-with-body --max-time 180 -X POST ${baseUrl}/sessions \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "system": "你是一位严谨的命理解读师",
    "fateclaw": {
      "board": { "type": "bazi", "text": "<第 2 步返回的 text>" },
      "skills": ["<第 3 步的 skill id，可省略>"]
    }
  }'`}</Code>
                    <Code lang="json">{`{ "id": "sess_AbC123...", "object": "session", "model": "...", "status": "active" }`}</Code>
                    <P>
                      拿到 <C>id</C>（即 <C>sid</C>），后续多轮都用它。
                    </P>
                  </Step>

                  <Step n={5} title="发消息解读（可多轮）">
                    <Code lang="curl">{`curl --fail-with-body --max-time 180 -X POST ${baseUrl}/sessions/sess_AbC123.../messages \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"帮我解读事业走向"}'`}</Code>
                    <Code lang="json">{`{
  "object": "chat.completion",
  "choices": [{ "message": { "role": "assistant", "content": "……解读正文……" } }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}`}</Code>
                    <P>
                      再发一条即多轮，历史自动延续、盘面无需重发。同一会话需
                      <strong className="text-ink">串行</strong>
                      （上一条没返回就发下一条会得到 409）。
                    </P>
                  </Step>

                  <Step n={6} title="结束（可选）">
                    <Code lang="curl">{`curl --fail-with-body --max-time 180 -X DELETE ${baseUrl}/sessions/sess_AbC123... \\
  -H "Authorization: Bearer $FATECLAW_API_KEY"`}</Code>
                    <P>删除会话；不删也会在 30 天不活动后自动过期。</P>
                  </Step>
                </div>
              </Section>
            </div>
          )}

          {/* 排盘 */}
          {tab === 'paipan' && (
            <div className="space-y-8">
              <div id="paipan-overview" className="scroll-mt-24 space-y-4">
                <h2 className="border-b border-hairline pb-4 text-xl font-medium text-ink">
                  排盘 API
                </h2>
                <P>
                  排盘是本地确定性计算，
                  <strong className="text-ink">不计费</strong>
                  （需要有效 API Key，且账户不欠费）。 每个排盘都返回{' '}
                  <C>{`{ type, text, data }`}</C>，参数统一 <C>snake_case</C>。
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
              <Section id="agent-chat" title="AI 解读（有状态会话）">
                <P>
                  解读是<strong className="text-ink">有状态会话</strong>
                  ：先建一个会话，一次性设定人设、盘面、技能，拿到一个
                  <C>sid</C>；之后每轮只发本轮提问，
                  <strong className="text-ink">历史和盘面服务端记着</strong>
                  ，无需重发。
                </P>
                <Note>
                  两步走：<strong className="text-ink">① POST /sessions</strong>{' '}
                  建会话（可带 <C>system</C> / <C>fateclaw.board</C> /{' '}
                  <C>fateclaw.skills</C>）→ 拿 <C>id</C>；
                  <strong className="text-ink">
                    ② POST /sessions/{'{id}'}/messages
                  </strong>{' '}
                  发提问，可多轮。响应 <C>usage</C> 为真实 token 数。 同一会话需
                  <strong className="text-ink">串行</strong>
                  发消息（上一条未完成时发下一条返回 409）。会话 30
                  天不活动自动过期（每次发消息顺延）。
                </Note>

                <Label>① 建会话</Label>
                <Endpoint method="POST" path="/api/v1/sessions" />
                <ParamTable params={SESSION_CREATE_PARAMS} />
                <P>
                  解读一张盘：把 <C>/api/v1/paipan/:type</C> 的返回填进{' '}
                  <C>fateclaw.board</C>（优先 <C>text</C>，缺失才用 <C>data</C>
                  ）。盘面只在这里传一次。
                </P>
                <Code lang="curl">{`curl --fail-with-body --max-time 180 -X POST ${baseUrl}/sessions \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "system": "你是一位严谨的命理解读师。",
    "fateclaw": {
      "board": {
        "type": "bazi",
        "text": "<来自 /api/v1/paipan/bazi 的 text>"
      }
    }
  }'`}</Code>
                <Code lang="json">{`{
  "id": "sess_xxxxxxxx",
  "object": "session",
  "model": "<official-model-key>",
  "status": "active",
  "created_at": "2026-10-18T00:00:00Z",
  "last_active_at": "2026-10-18T00:00:00Z",
  "expires_at": "2026-11-17T00:00:00Z"
}`}</Code>

                <Label>② 发消息（可多轮）</Label>
                <Endpoint method="POST" path="/api/v1/sessions/{id}/messages" />
                <ParamTable params={SESSION_MESSAGE_PARAMS} />
                <Code lang="curl">{`curl --fail-with-body --max-time 180 -X POST ${baseUrl}/sessions/sess_xxxxxxxx/messages \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "content": "请帮我解读这张盘的事业走向。" }'`}</Code>
                <P>
                  Python 示例：先安装 <C>requests</C>
                  ，并设置服务端环境变量。请求最长等待 180 秒。
                </P>
                <Code lang="python">{`import os
import requests

BASE = "${baseUrl}"
H = {"Authorization": "Bearer " + os.environ["FATECLAW_API_KEY"]}

# Create a session with the board once.
sid = requests.post(f"{BASE}/sessions", headers=H, json={
    "system": "你是一位严谨的命理解读师。",
    "fateclaw": {"board": {"type": "bazi", "text": "<paipan text>"}},
}, timeout=180).json()["id"]

# Send only the new content on subsequent turns.
r1 = requests.post(f"{BASE}/sessions/{sid}/messages", headers=H,
                   json={"content": "解读事业走向。"}, timeout=180).json()
print(r1["choices"][0]["message"]["content"])

r2 = requests.post(f"{BASE}/sessions/{sid}/messages", headers=H,
                   json={"content": "那感情呢？"}, timeout=180).json()  # The server retains previous context.
print(r2["choices"][0]["message"]["content"])`}</Code>

                <Label>返回</Label>
                <P>
                  解读正文在 <C>choices[0].message.content</C>，<C>usage</C>{' '}
                  为真实 token 用量（OpenAI <C>chat.completion</C>{' '}
                  风格响应体）。
                  整段解读生成完才返回，长解读请把客户端读超时设宽松些。
                </P>

                <Label>管理会话</Label>
                <P>
                  <C>GET /api/v1/sessions/{'{id}'}</C> 查会话元信息；
                  <C>DELETE /api/v1/sessions/{'{id}'}</C> 删除会话（之后该 sid
                  续聊返回 404）。
                </P>
              </Section>

              <Section id="agent-models" title="模型">
                <Endpoint method="GET" path="/api/v1/models" />
                <P>
                  返回当前唯一可用的官方模型（OpenAI 兼容 <C>list</C>{' '}
                  结构），最多一项。建会话时可省略 <C>model</C>。
                </P>
                <Code lang="json">{`{
  "object": "list",
  "data": [
    { "id": "<model_key>", "object": "model", "owned_by": "fateclaw" }
  ]
}`}</Code>
                <Note>
                  模型暂不可用时列表为空。每轮对话使用后台当前设定的模型和思考等级，已有会话也随配置更新；请求无法指定思考等级。
                </Note>
              </Section>

              <Section id="agent-skills" title="技能">
                <Endpoint method="GET" path="/api/v1/skills" />
                <P>
                  返回你<strong className="text-ink">有效可用</strong>
                  的技能（自有已启用 + 订阅已启用），其 <C>id</C> 即建会话{' '}
                  <C>fateclaw.skills</C> 所需的 UUID。先调它拿 <C>id</C>，再填进{' '}
                  <C>POST /sessions</C>。
                </P>
                <Code lang="json">{`{
  "object": "list",
  "data": [
    { "id": "<skill-uuid>", "object": "skill", "name": "技能名", "description": "简介", "source": "self" }
  ]
}`}</Code>
                <Note>
                  只列出当前可用的技能；这里没有的 id 即便填进{' '}
                  <C>fateclaw.skills</C> 也会被静默忽略。<C>source</C>：
                  <C>self</C>=自有，<C>subscribed</C>=订阅。
                </Note>
              </Section>
            </div>
          )}

          {/* 参考 */}
          {tab === 'reference' && (
            <div className="space-y-12">
              <Section id="ref-billing" title="计费">
                <Bullets
                  items={[
                    '排盘免费：所有排盘接口不扣积分（需要有效 API Key，且账户不欠费）。',
                    '解读按 token 计费：按官方模型输入 / 输出单价扣积分，普通用户按会员价的 1.5 倍计费，与站内一致。',
                    '账户欠费会拦截所有请求（402）；会员到期后已有有效 API Key 仍可调用。',
                    '所有解读统一使用后台配置的官方模型与思考等级。',
                  ]}
                />
              </Section>

              <Section id="ref-ratelimit" title="限流">
                <P>
                  每个 API Key 默认{' '}
                  <strong className="text-ink">60 次 / 分钟</strong>，超出返回
                  429，并在 <C>Retry-After</C>{' '}
                  头给出需等待的秒数。此外，连续鉴权失败会临时限制来源 IP。
                </P>
              </Section>

              <Section id="ref-errors" title="错误码">
                <P>
                  所有错误统一返回如下结构（<C>param</C> 恒为 <C>null</C>）：
                </P>
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
                    <span key="s" className="font-mono font-medium">
                      {e.status}
                    </span>,
                    <C key="c">{e.code}</C>,
                    <span key="t" className="font-mono text-[11px] text-muted">
                      {e.type}
                    </span>,
                    <span key="w" className="text-muted">
                      {e.when}
                    </span>,
                  ])}
                />
                <Note>
                  排盘的<strong className="text-ink">参数问题</strong>是 400，
                  <strong className="text-ink">执行阶段</strong>
                  的问题（比如时间非法、漏传该方式必需的参数）是
                  500；判断具体原因看 <C>code</C> 字段即可。
                </Note>
              </Section>
            </div>
          )}
          <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5">
            <span className="text-[11px] text-muted">下一步</span>
            <a
              href={`#${tab === 'start' ? 'paipan-overview' : tab === 'paipan' ? 'agent-chat' : tab === 'agent' ? 'ref-billing' : 'start-intro'}`}
              className="inline-flex min-h-9 items-center gap-2 text-xs font-medium text-primary"
            >
              {tab === 'start'
                ? '探索排盘 API'
                : tab === 'paipan'
                  ? '接入 AI 解读'
                  : tab === 'agent'
                    ? '了解计费与限流'
                    : '返回快速开始'}
              <ArrowRight size={14} />
            </a>
          </div>
        </article>
      </div>
    </DeveloperShell>
  );
}
