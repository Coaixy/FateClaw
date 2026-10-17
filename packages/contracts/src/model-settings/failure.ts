import type { PublicReasonCode } from '../common/reason-codes.js';
import type { ModelPoolKey } from './index.js';

const FAILURE_INFO = {
  authentication: [
    'model_auth_error',
    '上游服务认证失败',
    '上游服务认证失败，需要管理员检查模型服务配置。',
    'admin',
  ],
  permission: [
    'model_permission_denied',
    '上游拒绝访问',
    '上游服务拒绝访问，可能与模型权限或服务限制有关。',
    'admin',
  ],
  quota: [
    'model_quota_exhausted',
    '上游额度不足',
    '上游服务额度不足，暂时无法完成请求，需要等待额度恢复或由管理员处理。',
    'admin',
  ],
  shared_pool_rate_limit: [
    'rate_limited',
    '上游共享额度限流',
    '上游共享调用额度暂时触发限流，本次未能完成回答。',
    'retry',
  ],
  rate_limit: [
    'rate_limited',
    '上游限流',
    '上游服务触发限流，暂时无法接收更多请求。',
    'retry',
  ],
  not_found: [
    'model_not_found',
    '模型或接口不存在',
    '上游服务未找到请求的模型或接口，可能已下线或配置有误。',
    'admin',
  ],
  timeout: [
    'agent_timeout',
    '上游响应超时',
    '上游模型响应超时，本次未能完成回答。',
    'retry',
  ],
  overloaded: [
    'model_overloaded',
    '上游服务过载',
    '上游模型服务过载，暂时无法处理请求。',
    'retry',
  ],
  unavailable: [
    'model_unavailable',
    '上游服务故障',
    '上游模型发生服务故障或暂不可用，本次未能完成回答。',
    'retry',
  ],
  network: [
    'model_network_error',
    '上游连接失败',
    '平台与上游模型服务的连接失败，本次未能完成回答。',
    'retry',
  ],
  context: [
    'context_too_long',
    '消息内容过长',
    '消息内容过长，或本次对话超出了模型可处理的长度。',
    'shorten',
  ],
  content_filter: [
    'model_content_filtered',
    '上游内容拦截',
    '上游模型的内容安全规则拦截了本次请求或回答。',
    'rephrase',
  ],
  invalid_request: [
    'model_request_invalid',
    '请求格式或参数不兼容',
    '上游模型无法接受当前请求的格式或参数。',
    'admin',
  ],
  empty_response: [
    'model_empty_response',
    '上游返回空回复',
    '上游模型返回了空回复，本次未生成可用回答。',
    'retry',
  ],
  interrupted: [
    'model_response_interrupted',
    '上游回复中断',
    '上游模型的回复在完成前中断，本次回答未完成。',
    'retry',
  ],
  pool_unavailable: [
    'model_pool_unavailable',
    '没有可用的模型通道',
    '当前没有可用的模型通道，暂时无法处理请求。',
    'retry',
  ],
  unknown: [
    'model_error',
    '上游原因未识别',
    '调用失败，未能识别上游返回的具体原因。',
    'admin',
  ],
  internal: [
    'internal_error',
    '平台内部处理异常',
    '平台在处理模型请求时发生内部错误，本次未能完成。',
    'admin',
  ],
} as const satisfies Record<
  string,
  readonly [
    PublicReasonCode,
    string,
    string,
    'admin' | 'retry' | 'shorten' | 'rephrase',
  ]
>;

export type ModelFailureKind = keyof typeof FAILURE_INFO;

/** Only allowlisted categories cross the provider boundary, never raw details. */
export interface ModelFailure {
  kinds: ModelFailureKind[];
}

export function readModelFailure(value: unknown): ModelFailure | undefined {
  const kinds = record(value).kinds;
  if (
    !Array.isArray(kinds) ||
    !kinds.length ||
    !kinds.every(
      (kind) => typeof kind === 'string' && Object.hasOwn(FAILURE_INFO, kind),
    )
  )
    return undefined;
  return { kinds: [...new Set(kinds)] as ModelFailureKind[] };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorPayload(message: string): Record<string, unknown> {
  const start = message.indexOf('{');
  if (start < 0) return {};
  try {
    return record(JSON.parse(message.slice(start)));
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

const TYPED_FAILURES: Record<string, ModelFailureKind> = {
  authentication: 'authentication',
  authentication_error: 'authentication',
  invalid_api_key: 'authentication',
  api_key_invalid: 'authentication',
  unauthenticated: 'authentication',
  permission_denied: 'permission',
  permission_error: 'permission',
  payment_required: 'quota',
  billing_error: 'quota',
  insufficient_quota: 'quota',
  rate_limit_exceeded: 'rate_limit',
  rate_limit_error: 'rate_limit',
  resource_exhausted: 'rate_limit',
  context_length_exceeded: 'context',
  string_too_long: 'context',
  request_too_large: 'context',
  payload_too_large: 'context',
  content_policy_violation: 'content_filter',
  content_filter: 'content_filter',
  refusal: 'content_filter',
  provider_overloaded: 'overloaded',
  overloaded_error: 'overloaded',
  provider_unavailable: 'unavailable',
  unavailable: 'unavailable',
  server: 'unavailable',
  server_error: 'unavailable',
  api_error: 'unavailable',
  internal: 'unavailable',
  not_found: 'not_found',
  not_found_error: 'not_found',
  model_not_found: 'not_found',
  timeout: 'timeout',
  timeout_error: 'timeout',
  deadline_exceeded: 'timeout',
  invalid_request: 'invalid_request',
  invalid_request_error: 'invalid_request',
  invalid_argument: 'invalid_request',
  invalid_prompt: 'invalid_request',
  unprocessable: 'invalid_request',
};

/** Specific provider details take precedence over lossy HTTP statuses such as 403/429. */
export function classifyModelFailure(
  message: string,
  httpStatus?: number,
): ModelFailureKind | undefined {
  const payload = errorPayload(message);
  const error = Object.hasOwn(payload, 'error')
    ? record(payload.error)
    : payload;
  const metadata = record(error.metadata);
  const typed = [
    payload.error_type,
    metadata.error_type,
    error.error_type,
    error.code,
    error.type,
    error.status,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => {
      const key = value.toLowerCase();
      return Object.hasOwn(TYPED_FAILURES, key)
        ? TYPED_FAILURES[key]
        : undefined;
    })
    .find((value) => value !== undefined);
  const details =
    [error.message, metadata.raw]
      .filter((value): value is string => typeof value === 'string')
      .join(' ') || message;
  const status =
    httpStatus && httpStatus >= 400
      ? httpStatus
      : Number(error.code) ||
        Number(message.match(/^(?:HTTP\s+)?([45]\d{2})\b/i)?.[1]);

  // Some providers return spend/quota exhaustion as a generic rate-limit error.
  if (
    typed === 'quota' ||
    /insufficient[ _-]quota|quota.*(?:exhaust|deplet)|insufficient.*(?:balance|credit)|(?:balance|credit).*(?:insufficient|exhaust|too low)|(?:spend|spending|billing|budget).*limit.*(?:exceed|reach)|(?:daily|per[ _-]?day).*(?:limit|quota).*(?:exceed|reach)|(?:limit|quota).*(?:exceed|reach).*(?:daily|per[ _-]?day)|额度不足|余额不足|配额.*(?:耗尽|用尽)/i.test(
      details,
    )
  )
    return 'quota';
  if (
    metadata.limit_source === 'upstream_provider_shared_pool' &&
    (status === 429 ||
      typed === 'rate_limit' ||
      /rate[ _-]?limit/i.test(details))
  )
    return 'shared_pool_rate_limit';
  if (
    typed &&
    !['invalid_request', 'unavailable', 'permission', 'rate_limit'].includes(
      typed,
    )
  )
    return typed;
  if (
    /context[ _-]*(?:length|window|too[ _-]long)|maximum context|too many tokens|(?:input|prompt|request|message).*(?:too long|too large)|消息内容过长|上下文.*(?:过长|上限|超出)/i.test(
      details,
    )
  )
    return 'context';
  if (
    /content[ _-]*(?:policy|filter)|safety.*(?:block|filter)|blocked.*safety|prompt.*blocked|moderation.*(?:block|flag)|内容.*(?:拦截|过滤)/i.test(
      details,
    )
  )
    return 'content_filter';
  if (typed) return typed;
  if (
    /unauthori[sz]ed|invalid[ _-]api[ _-]key|incorrect api key|authentication[ _-](?:error|fail)/i.test(
      details,
    )
  )
    return 'authentication';
  if (/permission[ _-]denied|forbidden/i.test(details)) return 'permission';
  if (
    /model.*(?:not[ _-]found|does not exist|not exist)|no endpoints found/i.test(
      details,
    )
  )
    return 'not_found';
  if (/timeout|timed out|超时/i.test(details)) return 'timeout';
  if (/rate[ _-]?limit|too many requests|请求量较大|限流/i.test(details))
    return 'rate_limit';
  if (/overload|at capacity/i.test(details)) return 'overloaded';
  if (/stream.*(?:ended|interrupt)|terminated|premature close/i.test(details))
    return 'interrupted';
  if (/empty response|returned.*empty|空回复/i.test(details))
    return 'empty_response';
  if (
    /fetch failed|econnreset|econnrefused|enotfound|eai_again|socket|network|connection.*(?:error|closed|reset|failed)/i.test(
      details,
    )
  )
    return 'network';
  if (
    /invalid.*(?:request|schema|tool)|unsupported.*(?:parameter|tool|function)|not support.*(?:tool|function)/i.test(
      details,
    )
  )
    return 'invalid_request';
  if (
    /service unavailable|provider unavailable|provider returned error|internal server error|bad gateway/i.test(
      details,
    )
  )
    return 'unavailable';
  if (status === 401) return 'authentication';
  if (status === 402) return 'quota';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 413) return 'context';
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status >= 500 && status <= 599) return 'unavailable';
  if (status === 400 || status === 422) return 'invalid_request';
  return undefined;
}

export function formatModelFailure(
  failure: ModelFailure,
  poolKey: ModelPoolKey = 'official',
): {
  publicErrorText: string;
  publicReasonCode: PublicReasonCode;
} {
  const kinds = Object.keys(FAILURE_INFO).filter((kind) =>
    failure.kinds.includes(kind as ModelFailureKind),
  ) as ModelFailureKind[];
  const label = poolKey === 'benefit' ? '免费模型' : '官方模型';
  const retry =
    poolKey === 'benefit'
      ? '请稍后重试，或切换到官方模型继续。'
      : '请稍后重试；如持续出现，请反馈给管理员。';
  if (kinds.length > 1)
    return {
      publicErrorText: `${label}的服务通道均未能完成请求，原因包括：${kinds.map((kind) => FAILURE_INFO[kind][1]).join('、')}。${retry}`,
      publicReasonCode: 'model_error',
    };
  const [code, , description, action] = FAILURE_INFO[kinds[0] ?? 'unknown'];
  const advice =
    action === 'shorten'
      ? '请缩短消息，或新建对话后重试。'
      : action === 'rephrase'
        ? '请调整提问内容后重试。'
        : action === 'admin'
          ? `请反馈给管理员排查。${poolKey === 'benefit' ? '也可以切换到官方模型继续。' : ''}`
          : retry;
  return {
    publicErrorText: `${label}：${description}${advice}`,
    publicReasonCode: code,
  };
}
