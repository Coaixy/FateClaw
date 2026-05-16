import type {
  ToolErrorCode,
  ToolErrorInfo,
  ToolErrorKind,
  ToolErrorNextAction,
  ToolResult,
} from '../../types.js';

interface CreateToolErrorOptions {
  code: ToolErrorCode;
  kind: ToolErrorKind;
  retryable: boolean;
  userSafe: boolean;
  nextAction: ToolErrorNextAction;
  internalMessage: string;
  userMessage?: string;
  details?: Record<string, unknown>;
}

/**
 * 统一构造结构化工具错误，避免各个 skill 工具自行拼对象导致字段漂移。
 */
export function createToolError(
  options: CreateToolErrorOptions,
): ToolErrorInfo {
  return {
    code: options.code,
    kind: options.kind,
    retryable: options.retryable,
    userSafe: options.userSafe,
    nextAction: options.nextAction,
    userMessage: options.userMessage,
    internalMessage: options.internalMessage,
    details: options.details,
  };
}

/**
 * 统一构造带结构化错误的 ToolResult。
 */
export function createToolErrorResult(
  options: CreateToolErrorOptions,
  overrides?: Omit<Partial<ToolResult>, 'output' | 'isError' | 'error'>,
): ToolResult {
  const error = createToolError(options);
  return {
    output: error.internalMessage,
    isError: true,
    error,
    ...overrides,
  };
}

