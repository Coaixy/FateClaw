import { ZodError } from 'zod';

const DEFAULT_CLIENT_ERROR_MESSAGE = '请求参数错误';
const DEFAULT_SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试';
const INVALID_JSON_MESSAGE = '请求体不是合法的 JSON';

export interface NormalizedHttpError {
  statusCode: number;
  publicMessage: string;
}

type HttpErrorLike = Error & {
  statusCode?: number;
  code?: string;
};

function getZodMessage(error: ZodError): string {
  return error.issues[0]?.message || DEFAULT_CLIENT_ERROR_MESSAGE;
}

export function normalizeHttpError(error: HttpErrorLike): NormalizedHttpError {
  // Zod 校验异常默认没有 statusCode，需要主动归一化为 400。
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      publicMessage: getZodMessage(error),
    };
  }

  // JSON 解析失败属于请求体错误，不应向前端暴露底层 SyntaxError 细节。
  if (
    error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    (error instanceof SyntaxError &&
      (error.statusCode === 400 || /JSON/i.test(error.message)))
  ) {
    return {
      statusCode: 400,
      publicMessage: INVALID_JSON_MESSAGE,
    };
  }

  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    return {
      statusCode,
      publicMessage: DEFAULT_SERVER_ERROR_MESSAGE,
    };
  }

  return {
    statusCode,
    publicMessage: error.message?.trim() || DEFAULT_CLIENT_ERROR_MESSAGE,
  };
}
