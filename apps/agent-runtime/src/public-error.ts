import type { LlmRuntimeSnapshot, PublicReasonCode } from './types.js';

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatConfiguredValue(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : '未配置';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatSensitiveConfiguredValue(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return '未配置';
  return '已配置';
}

function redactExactValue(text: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return text;
  return text.replace(new RegExp(escapeRegExp(normalized), 'g'), '[已脱敏]');
}

function redactLikelyApiKeys(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已脱敏]')
    .replace(/(api[_ -]?key\s*[:=]\s*)\S+/gi, '$1[已脱敏]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1[已脱敏]');
}

function redactLikelyUrls(text: string): string {
  // Provider 可能回显实际请求端点而不只是配置的 Base URL，因此统一隐藏完整 HTTP(S) URL。
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[已脱敏]');
}

export function redactRuntimeSensitiveValues(
  text: string,
  runtime?: LlmRuntimeSnapshot,
): string {
  text = redactLikelyUrls(text);
  for (const config of runtime ? [runtime, ...(runtime.poolNodes ?? [])] : []) {
    text = redactExactValue(
      redactExactValue(text, config.apiKey),
      config.baseUrl,
    );
  }
  return redactLikelyApiKeys(text);
}

function inferCustomModelFailureCause(error: string): string {
  if (
    /401|unauthorized|invalid api key|incorrect api key|authentication/i.test(
      error,
    )
  ) {
    return '优先检查 API Key 是否正确、是否过期，以及认证方式是否选对。';
  }
  if (
    /402|403|payment required|forbidden|permission|billing|quota|insufficient|balance|credit|余额|欠费/i.test(
      error,
    )
  ) {
    return '优先检查 API Key 权限、账户额度、项目权限或供应商控制台限制。';
  }
  if (
    /404|not found|model.*not.*exist|model.*not.*found|does not exist/i.test(
      error,
    )
  ) {
    return '优先检查模型名是否存在，Base URL 是否带错路径，或该端点是否支持当前协议类型。';
  }
  if (
    /400|bad request|invalid request|schema|tool|tool_choice|function/i.test(
      error,
    )
  ) {
    return '优先检查模型是否兼容当前协议类型、工具调用参数，以及 Base URL 是否指向兼容接口。';
  }
  if (
    /timeout|timed out|econnreset|socket|network|fetch failed|enotfound|econnrefused/i.test(
      error,
    )
  ) {
    return '优先检查 Base URL 网络连通性、网关地址、代理、防火墙或供应商服务状态。';
  }
  if (/429|rate limit|too many requests/i.test(error)) {
    return '优先检查供应商限流、并发限制或账户调用频率。';
  }
  return '请按下面的供应商原始错误，核对模型名、Base URL、API Key 和认证方式。';
}

function formatCustomModelError(
  error: string,
  runtime: LlmRuntimeSnapshot,
): string {
  const providerError = normalizeWhitespace(
    redactRuntimeSensitiveValues(error, runtime),
  );
  return [
    '自配模型调用失败，当前使用的配置如下：',
    `协议类型：${runtime.piApi}`,
    `模型名：${formatConfiguredValue(runtime.model)}`,
    `Base URL：${formatSensitiveConfiguredValue(runtime.baseUrl)}`,
    `认证方式：${runtime.authMode}`,
    `API Key：${formatSensitiveConfiguredValue(runtime.apiKey)}`,
    `供应商原始错误：${providerError || '无错误详情'}`,
    `排查方向：${inferCustomModelFailureCause(providerError)}`,
  ].join('\n');
}

export function mapContainerErrorToPublicError(
  error: string,
  options?: { llmRuntime?: LlmRuntimeSnapshot },
): {
  publicErrorText: string;
  /** 机器可读的失败原因码，取值集合与 contracts 的 PUBLIC_REASON_CODES 一致。 */
  publicReasonCode: PublicReasonCode;
} {
  if (options?.llmRuntime?.source === 'custom') {
    return {
      publicErrorText: formatCustomModelError(error, options.llmRuntime),
      publicReasonCode: 'custom_model_error',
    };
  }

  if (/timeout|timed out|超时/i.test(error)) {
    return {
      publicErrorText: '这次处理超时了，请稍后再试。',
      publicReasonCode: 'agent_timeout',
    };
  }
  if (/429|rate limit|请求量较大/i.test(error)) {
    return {
      publicErrorText: '当前请求量较大，请稍后再试。',
      publicReasonCode: 'rate_limited',
    };
  }
  if (/消息内容过长|context|token|too.long|maximum/i.test(error)) {
    return {
      publicErrorText: '这次消息内容太长，处理被中断。请精简后重试。',
      publicReasonCode: 'context_too_long',
    };
  }
  if (
    /还缺少这些信息|缺少必要输入|出生时间|出生日期|性别|三个数字|六爻/.test(
      error,
    )
  ) {
    return {
      publicErrorText: redactRuntimeSensitiveValues(error, options?.llmRuntime),
      publicReasonCode: 'missing_input',
    };
  }
  if (/协议错误/.test(error)) {
    return {
      publicErrorText: redactRuntimeSensitiveValues(error, options?.llmRuntime),
      publicReasonCode: 'protocol_error',
    };
  }
  return {
    publicErrorText: `这次没有完成，原因：${redactRuntimeSensitiveValues(
      error,
      options?.llmRuntime,
    )}`,
    publicReasonCode: 'internal_error',
  };
}
