import { createHash } from 'crypto';

import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import type { SoulStore } from '#agent/deps';
import {
  completePiToolExecution,
  type PiToolRuntimeOptions,
} from './tool-execution.js';

const MAX_SOUL_CONTENT_CHARS = 50_000;

const readSoulParamsSchema = Type.Object({});

const editSoulParamsSchema = Type.Object({
  baseHash: Type.String({
    description:
      '调用 read_soul 后得到的 sha256；用于避免覆盖用户刚在 Dashboard 或其他请求中修改过的 Soul。',
  }),
  newContent: Type.String({
    description: '新的完整 Soul 内容。必须完整覆盖旧 Soul，不能只传局部片段。',
  }),
  reason: Type.String({
    description:
      '本次编辑 Soul 的原因；应对应用户本轮明确提出的记住、修改或删除要求。',
  }),
});

type ReadSoulParams = Static<typeof readSoulParamsSchema>;
type EditSoulParams = Static<typeof editSoulParamsSchema>;

interface PiSoulReadDetails {
  output: string;
  isError: boolean;
  content: string;
  charCount: number;
  sha256: string;
  maxContentChars: number;
}

interface PiSoulEditDetails {
  output: string;
  isError: boolean;
  reason?: string;
  previousHash?: string;
  newHash?: string;
  charCount?: number;
  error?: string;
}

/**
 * 创建 Soul 工具所需的依赖。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - recordExecution：工具执行记录回调。
 * - accountId：当前 agent-runtime 账号 ID，用于定位 Dashboard 维护的唯一 Soul。
 * - soulStore：Soul 读写存储，实际读写 users.soul_content 或历史账号级 fallback。
 *
 * 注意：Soul 是用户唯一长期记忆/人格配置，不要把它拆成额外 memory 或 persona。
 */
export interface CreatePiSoulToolOptions extends PiToolRuntimeOptions {
  accountId: string;
  soulStore: SoulStore;
  soulEditEnabled?: boolean;
}

function hashSoul(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildOutput<T extends Record<string, unknown>>(details: T): string {
  return JSON.stringify(details, null, 2);
}

function normalizeReadParams(): ReadSoulParams {
  return {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeEditParams(args: unknown): EditSoulParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      baseHash: '',
      newContent: '',
      reason: '',
    };
  }
  const raw = args as Record<string, unknown>;
  return {
    baseHash: readString(raw.baseHash).trim(),
    newContent: readString(raw.newContent),
    reason: readString(raw.reason).trim(),
  };
}

/**
 * 创建 Pi 的 Soul 读取工具。
 *
 * 参数：CreatePiSoulToolOptions。
 * 返回：可注册到 Pi customTools 的 read_soul 工具定义。
 * 注意：本工具读取 Dashboard 维护的同一份 Soul，并返回 hash 供 edit_soul 做并发保护。
 */
export function createPiSoulReadTool(
  options: CreatePiSoulToolOptions,
): PiToolDefinition {
  const soulEditEnabled = options.soulEditEnabled ?? true;
  return defineTool({
    name: 'read_soul',
    label: 'read_soul',
    description: soulEditEnabled
      ? '读取当前用户唯一的 Soul（Dashboard 维护的长期记忆、人格、表达偏好和长期背景），并返回 sha256 供后续 edit_soul 校验。'
      : '读取当前用户唯一的 Soul（Dashboard 维护的长期记忆、人格、表达偏好和长期背景）。当前用户关闭了对话编辑 Soul。',
    promptSnippet: soulEditEnabled
      ? 'Use read_soul before editing the user Soul, or when the user asks to inspect their Soul.'
      : 'Use read_soul when the user asks to inspect their Soul. Soul editing is disabled for this user.',
    promptGuidelines: [
      'Soul 是用户唯一长期记忆/人格配置；不要把它叫成另一套 memory 或 persona。',
      soulEditEnabled
        ? '编辑 Soul 前必须先调用 read_soul，并把返回的 sha256 作为 edit_soul.baseHash。'
        : '当前用户关闭了对话编辑 Soul；本轮不会提供 edit_soul，不能声称已保存、修改或删除长期记忆。',
      '只有用户明确要求查看 Soul 时才展示全文；普通回答优先使用 system prompt 中已注入的 Soul。',
    ],
    parameters: readSoulParamsSchema,
    executionMode: 'sequential',
    prepareArguments: normalizeReadParams,
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiSoulReadDetails>> {
      const startedAt = Date.now();
      const content = await options.soulStore.read(options.accountId);
      const details: PiSoulReadDetails = {
        output: '',
        isError: false,
        content,
        charCount: content.length,
        sha256: hashSoul(content),
        maxContentChars: MAX_SOUL_CONTENT_CHARS,
      };
      details.output = buildOutput({
        isError: details.isError,
        content: details.content,
        charCount: details.charCount,
        sha256: details.sha256,
        maxContentChars: details.maxContentChars,
      });

      return completePiToolExecution({
        options,
        toolCallId,
        toolName: 'read_soul',
        params: params as Record<string, unknown>,
        output: details.output,
        details,
        isError: false,
        traceType: 'pi_soul_read_completed',
        startedAt,
        traceFields: {
          charCount: content.length,
        },
      });
    },
  });
}

/**
 * 创建 Pi 的 Soul 编辑工具。
 *
 * 参数：CreatePiSoulToolOptions。
 * 返回：可注册到 Pi customTools 的 edit_soul 工具定义。
 * 注意：本工具只接受完整新 Soul，并用 baseHash 拒绝过期覆盖。
 */
export function createPiSoulEditTool(
  options: CreatePiSoulToolOptions,
): PiToolDefinition {
  return defineTool({
    name: 'edit_soul',
    label: 'edit_soul',
    description:
      '在用户本轮明确要求记住、修改或删除 Soul 时，完整覆盖当前用户唯一的 Soul。',
    promptSnippet:
      'Use edit_soul only after read_soul and only for an explicit user request to remember, update, or delete Soul content.',
    promptGuidelines: [
      '只有用户本轮明确要求“记住、保存、修改、删除、以后都按这个来”等长期记忆管理时，才可调用 edit_soul。',
      '不要把普通对话、一次性上下文、工具结果、验证码、密钥、支付信息或其他敏感信息写入 Soul。',
      '必须先 read_soul，再用 read_soul.sha256 作为 baseHash；newContent 必须是完整 Soul。',
      'edit_soul 更新的是后续请求会注入 system prompt 的 Dashboard Soul；当前轮如需遵循新内容，应基于工具返回结果继续回答。',
    ],
    parameters: editSoulParamsSchema,
    executionMode: 'sequential',
    prepareArguments: normalizeEditParams,
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiSoulEditDetails>> {
      const startedAt = Date.now();
      const currentContent = await options.soulStore.read(options.accountId);
      const currentHash = hashSoul(currentContent);
      const normalizedNewContent = params.newContent.trimEnd();

      let details: PiSoulEditDetails;
      if (!params.baseHash) {
        details = {
          output: '',
          isError: true,
          reason: params.reason,
          previousHash: currentHash,
          error: '拒绝编辑 Soul：缺少 baseHash。请先调用 read_soul。',
        };
      } else if (params.baseHash !== currentHash) {
        details = {
          output: '',
          isError: true,
          reason: params.reason,
          previousHash: currentHash,
          error:
            '拒绝编辑 Soul：baseHash 与当前 Soul 不一致。请重新调用 read_soul 后再编辑。',
        };
      } else if (normalizedNewContent.length > MAX_SOUL_CONTENT_CHARS) {
        details = {
          output: '',
          isError: true,
          reason: params.reason,
          previousHash: currentHash,
          charCount: normalizedNewContent.length,
          error: `拒绝编辑 Soul：内容长度 ${normalizedNewContent.length} 超过上限 ${MAX_SOUL_CONTENT_CHARS}。`,
        };
      } else {
        const updated = await options.soulStore.update(
          options.accountId,
          normalizedNewContent,
          params.baseHash,
        );
        details = updated
          ? {
              output: '',
              isError: false,
              reason: params.reason,
              previousHash: currentHash,
              newHash: hashSoul(normalizedNewContent),
              charCount: normalizedNewContent.length,
            }
          : {
              output: '',
              isError: true,
              reason: params.reason,
              previousHash: currentHash,
              error:
                'Soul changed before it could be saved. Call read_soul again before editing.',
            };
      }

      details.output = buildOutput({
        isError: details.isError,
        reason: details.reason,
        previousHash: details.previousHash,
        newHash: details.newHash,
        charCount: details.charCount,
        error: details.error,
        note: details.isError
          ? undefined
          : 'Soul 已更新；新的 Soul 会从下一次 Pi Runtime 请求开始重新注入 system prompt。',
      });

      return completePiToolExecution({
        options,
        toolCallId,
        toolName: 'edit_soul',
        params: params as Record<string, unknown>,
        output: details.output,
        details,
        isError: details.isError,
        traceType: 'pi_soul_edit_completed',
        startedAt,
        traceFields: {
          charCount: details.charCount,
          hasError: details.isError,
        },
      });
    },
  });
}
