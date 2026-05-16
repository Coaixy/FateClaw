/**
 * Gemini 原生协议客户端封装。
 *
 * 通过 fetch 调用 Gemini API（支持 yunwu.ai 等代理服务），
 * 提供与官方 SDK 类似的接口但支持自定义 baseURL。
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface GeminiClientConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: unknown;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiFunctionCallingConfig {
  mode?: 'AUTO' | 'ANY' | 'NONE';
  allowedFunctionNames?: string[];
}

export interface GeminiToolConfig {
  functionCallingConfig?: GeminiFunctionCallingConfig;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: GeminiGenerationConfig;
  cachedContent?: string;
}

export interface GeminiCreateCachedContentRequest {
  model?: string;
  contents?: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  ttl?: string;
  displayName?: string;
}

export interface GeminiCandidate {
  content: GeminiContent;
  finishReason: string;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiCachedContent {
  name: string;
  model?: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

// ---------------------------------------------------------------------------
// 客户端实现
// ---------------------------------------------------------------------------

export interface GeminiClient {
  /**
   * 创建显式上下文缓存。
   */
  createCachedContent(
    request: GeminiCreateCachedContentRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GeminiCachedContent>;

  /**
   * 非流式生成内容。
   */
  generateContent(
    request: GeminiGenerateContentRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GeminiGenerateContentResponse>;

  /**
   * 流式生成内容，返回 AsyncIterable。
   */
  generateContentStream(
    request: GeminiGenerateContentRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<GeminiStreamChunk>;
}

/**
 * 创建 Gemini 客户端实例。
 *
 * @param config - 客户端配置
 * @returns GeminiClient 实例
 */
export function createGeminiClient(config: GeminiClientConfig): GeminiClient {
  const { apiKey, baseURL, model } = config;

  // 规范化 baseURL（移除尾部斜杠）
  const normalizedBaseURL = baseURL.replace(/\/+$/, '');

  /**
   * 构建请求 URL。
   * Gemini API 端点格式：{baseURL}/v1beta/models/{model}:{action}
   */
  function buildModelPath(): string {
    return model.replace(/^models\//, '');
  }

  function buildModelResourceName(): string {
    return model.startsWith('models/') ? model : `models/${model}`;
  }

  function buildUrl(
    action: 'generateContent' | 'streamGenerateContent',
  ): string {
    return `${normalizedBaseURL}/v1beta/models/${buildModelPath()}:${action}`;
  }

  function buildCachedContentsUrl(): string {
    return `${normalizedBaseURL}/v1beta/cachedContents`;
  }

  /**
   * 构建请求头。
   */
  function buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    };
  }

  return {
    async createCachedContent(
      request: GeminiCreateCachedContentRequest,
      options?: { signal?: AbortSignal },
    ): Promise<GeminiCachedContent> {
      const url = buildCachedContentsUrl();
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          ...request,
          model: request.model ?? buildModelResourceName(),
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Gemini cache 创建失败: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return (await response.json()) as GeminiCachedContent;
    },

    async generateContent(
      request: GeminiGenerateContentRequest,
      options?: { signal?: AbortSignal },
    ): Promise<GeminiGenerateContentResponse> {
      const url = buildUrl('generateContent');
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(request),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Gemini API 请求失败: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return (await response.json()) as GeminiGenerateContentResponse;
    },

    async *generateContentStream(
      request: GeminiGenerateContentRequest,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<GeminiStreamChunk> {
      const url = `${buildUrl('streamGenerateContent')}?alt=sse`;
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(request),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Gemini API 流式请求失败: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      if (!response.body) {
        throw new Error('Gemini API 未返回响应体');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data) as GeminiStreamChunk;
              yield parsed;
            } catch {
              // 跳过无法解析的行
            }
          }
        }

        // 处理剩余 buffer
        if (buffer.trim().startsWith('data: ')) {
          const data = buffer.trim().slice(6);
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data) as GeminiStreamChunk;
              yield parsed;
            } catch {
              // 忽略
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 从 Gemini 响应中提取文本内容。
 */
export function extractText(response: GeminiGenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter(
      (p): p is GeminiPart & { text: string } => typeof p.text === 'string',
    )
    .map((p) => p.text)
    .join('');
}

/**
 * 从 Gemini 响应中提取函数调用。
 */
export function extractFunctionCalls(
  response: GeminiGenerateContentResponse,
): Array<{ name: string; args: Record<string, unknown> }> {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter(
      (
        p,
      ): p is GeminiPart & {
        functionCall: NonNullable<GeminiPart['functionCall']>;
      } => p.functionCall !== undefined,
    )
    .map((p) => ({
      name: p.functionCall.name,
      args: p.functionCall.args,
    }));
}

/**
 * 检查响应是否因安全过滤被阻止。
 */
export function isBlockedBySafety(
  response: GeminiGenerateContentResponse,
): boolean {
  return response.candidates?.[0]?.finishReason === 'SAFETY';
}

/**
 * 构建 systemInstruction 格式。
 */
export function buildSystemInstruction(text: string): {
  parts: Array<{ text: string }>;
} {
  return { parts: [{ text }] };
}

/**
 * 构建用户消息 Content。
 */
export function buildUserContent(text: string): GeminiContent {
  return { role: 'user', parts: [{ text }] };
}

/**
 * 构建模型消息 Content（包含文本和/或函数调用）。
 */
export function buildModelContent(
  text?: string,
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>,
): GeminiContent {
  const parts: GeminiPart[] = [];
  if (text) {
    parts.push({ text });
  }
  if (functionCalls) {
    for (const fc of functionCalls) {
      parts.push({ functionCall: { name: fc.name, args: fc.args } });
    }
  }
  return { role: 'model', parts };
}

/**
 * 构建函数响应 Content。
 */
export function buildFunctionResponseContent(
  responses: Array<{ name: string; response: unknown }>,
): GeminiContent {
  return {
    role: 'user',
    parts: responses.map((r) => ({
      functionResponse: { name: r.name, response: r.response },
    })),
  };
}
