import type { LlmRuntimeSnapshot } from './types.js';

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatConfiguredValue(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : '未配置';
}

function inferCustomModelFailureCause(error: string): string {
  if (/401|unauthorized|invalid api key|incorrect api key|authentication/i.test(error)) {
    return '优先检查 API Key 是否正确、是否过期，以及认证方式是否选对。';
  }
  if (/403|forbidden|permission|billing|quota|insufficient/i.test(error)) {
    return '优先检查 API Key 权限、账户额度、项目权限或供应商控制台限制。';
  }
  if (/404|not found|model.*not.*exist|model.*not.*found|does not exist/i.test(error)) {
    return '优先检查模型名是否存在，Base URL 是否带错路径，或该端点是否支持当前协议。';
  }
  if (/400|bad request|invalid request|schema|tool|tool_choice|function/i.test(error)) {
    return '优先检查模型是否兼容当前协议、工具调用参数，以及 Base URL 是否指向兼容接口。';
  }
  if (/timeout|timed out|econnreset|socket|network|fetch failed|enotfound|econnrefused/i.test(error)) {
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
  const providerError = normalizeWhitespace(error);
  return [
    '自配模型调用失败，当前使用的配置如下：',
    `协议：${runtime.provider}`,
    `模型名：${formatConfiguredValue(runtime.model)}`,
    `Base URL：${formatConfiguredValue(runtime.baseUrl)}`,
    `认证方式：${runtime.authMode}`,
    `API Key：${runtime.apiKey}`,
    `供应商原始错误：${providerError || '无错误详情'}`,
    `排查方向：${inferCustomModelFailureCause(providerError)}`,
  ].join('\n');
}

export function mapContainerErrorToPublicError(
  error: string,
  options?: { llmRuntime?: LlmRuntimeSnapshot },
): {
  publicErrorText: string;
  publicReasonCode: string;
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
  if (/还缺少这些信息|缺少必要输入|出生时间|出生日期|性别|三个数字|六爻/.test(error)) {
    return {
      publicErrorText: error,
      publicReasonCode: 'missing_input',
    };
  }
  if (/协议错误/.test(error)) {
    return {
      publicErrorText: error,
      publicReasonCode: 'protocol_error',
    };
  }
  return {
    publicErrorText: `这次没有完成，原因：${error}`,
    publicReasonCode: 'internal_error',
  };
}
