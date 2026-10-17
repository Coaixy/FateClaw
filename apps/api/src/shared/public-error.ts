import type { PublicReasonCode } from '@fateclaw/contracts';
import {
  classifyModelFailure,
  formatModelFailure,
} from '@fateclaw/contracts/model-settings';

export interface PublicErrorInfo {
  publicMessage: string;
  /** 机器可读的失败原因码，取值集合由 contracts 统一约束。 */
  publicReasonCode: PublicReasonCode;
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

  const modelFailureKind = classifyModelFailure(raw);
  if (raw.includes('收件箱请求超时') || modelFailureKind === 'timeout') {
    return {
      publicMessage: '这次处理超时了，请稍后再试。',
      publicReasonCode: 'agent_timeout',
      debugReason: sanitizeDetail(raw),
    };
  }

  if (modelFailureKind) {
    const publicError = formatModelFailure({ kinds: [modelFailureKind] });
    return {
      publicMessage: publicError.publicErrorText,
      publicReasonCode: publicError.publicReasonCode,
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
