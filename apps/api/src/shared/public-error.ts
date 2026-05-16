export interface PublicErrorInfo {
  publicMessage: string;
  publicReasonCode: string;
  debugReason?: string;
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitizeDetail(detail: string): string {
  return truncate(
    detail
      .replace(/https?:\/\/\S+/g, '[url]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[secret]')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export function mapInternalErrorToPublicError(
  error: string | undefined | null,
  options: { fallbackMessage?: string } = {},
): PublicErrorInfo {
  const raw = (error || '').trim();
  const fallbackMessage = options.fallbackMessage || '抱歉，AI 服务暂时不可用';

  if (raw.includes('收件箱请求超时') || /timeout|timed out/i.test(raw)) {
    return {
      publicMessage: '这次处理超时了，请稍后再试。',
      publicReasonCode: 'agent_timeout',
      debugReason: sanitizeDetail(raw),
    };
  }

  if (/rate limit|429|请求量较大/i.test(raw)) {
    return {
      publicMessage: '当前请求量较大，请稍后再试。',
      publicReasonCode: 'rate_limited',
      debugReason: sanitizeDetail(raw),
    };
  }

  if (/消息内容过长|context|token|too.long|maximum/i.test(raw)) {
    return {
      publicMessage: '这次消息内容太长，处理被中断。请精简后重试。',
      publicReasonCode: 'context_too_long',
      debugReason: sanitizeDetail(raw),
    };
  }

  if (/还缺少这些信息/.test(raw)) {
    return {
      publicMessage: raw,
      publicReasonCode: 'missing_input',
      debugReason: sanitizeDetail(raw),
    };
  }

  if (/缺少必要输入|出生时间|出生日期|性别|三个数字|六爻/.test(raw)) {
    return {
      publicMessage: `这次没有完成，原因：${sanitizeDetail(raw)}`,
      publicReasonCode: 'missing_input',
      debugReason: sanitizeDetail(raw),
    };
  }

  if (/协议错误/.test(raw)) {
    return {
      publicMessage: `这次没有完成，原因：${sanitizeDetail(raw)}`,
      publicReasonCode: 'protocol_error',
      debugReason: sanitizeDetail(raw),
    };
  }

  if (/路由|router/i.test(raw)) {
    return {
      publicMessage: `这次没有成功理解你的请求，原因：${sanitizeDetail(raw)}。请换一种更直接的说法再试。`,
      publicReasonCode: 'router_error',
      debugReason: sanitizeDetail(raw),
    };
  }

  return {
    publicMessage: raw
      ? `这次没有完成，原因：${sanitizeDetail(raw)}`
      : fallbackMessage,
    publicReasonCode: 'internal_error',
    debugReason: sanitizeDetail(raw),
  };
}
