import { Worker } from 'node:worker_threads';

import {
  defineTool,
  type AgentToolResult,
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { traceEvent } from '#agent/trace';
import {
  completePiToolExecution,
  type PiToolRuntimeOptions,
} from './tool-execution.js';
import { clampLimit, readBoolean, readString } from './param-utils.js';
import {
  DEFAULT_GREP_LIMIT,
  MAX_GREP_RESULTS,
  SKILL_GREP_TIMEOUT_MS,
  type SkillGrepParams,
  type SkillGrepResult,
  type SkillGrepWorkerInput,
  type SkillGrepWorkerOutput,
} from './skill-grep-protocol.js';

const grepParamsSchema = Type.Object({
  query: Type.String({
    description:
      '要在授权 Skill Markdown 文件中查找的内容；默认按 JavaScript 正则表达式匹配，regex=false 时按字面子串匹配。',
  }),
  path: Type.Optional(
    Type.String({
      description:
        '可选搜索范围。省略则检索所有授权 Skill。可传 <available_skills> 中的 SKILL.md 路径，或授权 Skill 目录内的相对 Markdown 路径；当传入指向单个文件的路径时，会自动把检索范围扩展到该文件所属 Skill 的整个目录（覆盖 docs/examples 等兄弟 Markdown）。',
    }),
  ),
  regex: Type.Optional(
    Type.Boolean({
      description:
        '匹配模式：默认按 JavaScript 正则表达式匹配（普通关键词不含元字符时等价子串）。当需要把含 . * ( ) [ ] 等字符的内容当字面查找时设为 false。正则非法时自动回退为字面匹配。',
    }),
  ),
  caseSensitive: Type.Optional(
    Type.Boolean({
      description: '是否区分大小写；默认 false。',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `最多返回多少条命中；默认 ${DEFAULT_GREP_LIMIT}，最大 ${MAX_GREP_RESULTS}。`,
    }),
  ),
});

interface PiSkillGrepDetails extends SkillGrepResult {
  query: string;
  path?: string;
  regex: boolean;
  caseSensitive: boolean;
}

export interface CreatePiSkillGrepToolOptions extends PiToolRuntimeOptions {
  readableSkills: Skill[];
}

function normalizeParams(args: unknown): SkillGrepParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { query: '' };
  }
  const raw = args as Record<string, unknown>;
  return {
    query: readString(raw.query) ?? '',
    path: readString(raw.path),
    regex: readBoolean(raw.regex),
    caseSensitive: readBoolean(raw.caseSensitive),
    limit: clampLimit(raw.limit, DEFAULT_GREP_LIMIT, MAX_GREP_RESULTS),
  };
}

function failedSearch(
  error: string,
  errorCode: NonNullable<SkillGrepResult['errorCode']>,
): SkillGrepResult {
  return {
    output: error,
    error,
    errorCode,
    isError: true,
    matches: [],
    total: 0,
    totalIsExact: false,
    truncated: true,
  };
}

function runGrepInWorker(
  params: SkillGrepParams,
  options: CreatePiSkillGrepToolOptions,
  fileLists: Map<string, string[]>,
  signal?: AbortSignal,
): Promise<SkillGrepResult> {
  const deadlineAt = Date.now() + SKILL_GREP_TIMEOUT_MS;
  const cancelled = () => failedSearch('搜索已取消。', 'skill_grep_cancelled');
  if (signal?.aborted) return Promise.resolve(cancelled());
  const fail = (error: unknown) => {
    traceEvent(
      {
        type: 'pi_skill_grep_worker_failed',
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      },
      options.requestScope,
    );
    return failedSearch('搜索失败，请稍后重试。', 'skill_grep_failed');
  };

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      // Node 24 runs the source worker directly; tsc emits its .js counterpart.
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      worker = new Worker(
        new URL(`./skill-grep-worker.${extension}`, import.meta.url),
        {
          workerData: {
            params,
            readableSkills: options.readableSkills.map(({ name, baseDir }) => ({
              name,
              baseDir,
            })),
            fileLists,
          } satisfies SkillGrepWorkerInput,
          env: {},
          execArgv: [],
        },
      );
    } catch (error) {
      resolve(fail(error));
      return;
    }

    let response: SkillGrepWorkerOutput | undefined;
    let failure: SkillGrepResult | undefined;
    let settled = false;
    const finish = (result: SkillGrepResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const stop = (result: SkillGrepResult) => {
      if (settled || failure) return;
      failure = result;
      // A rejected tool promise alone would leave the regex consuming CPU.
      void worker.terminate().catch((error: unknown) => {
        finish(fail(error));
      });
    };
    const onAbort = () => stop(cancelled());
    const timer = setTimeout(
      () => {
        stop(
          failedSearch(
            '搜索超时，请缩小搜索范围或简化正则表达式。',
            'skill_grep_timeout',
          ),
        );
      },
      Math.max(0, deadlineAt - Date.now()),
    );

    worker.once('message', (message: SkillGrepWorkerOutput) => {
      response = message;
    });
    worker.once('error', (error) => {
      failure ??= fail(error);
    });
    worker.once('exit', (code) => {
      if (failure) {
        finish(failure);
      } else if (code !== 0 || !response) {
        finish(
          fail(
            new Error(`Search worker exited without a result (code=${code})`),
          ),
        );
      } else {
        // Commit discovery only after the worker exits successfully.
        for (const [key, files] of response.fileLists)
          fileLists.set(key, files);
        finish(response.result);
      }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Search authorized Skill Markdown while keeping regex execution off the daemon thread. */
export function createPiSkillGrepTool(
  options: CreatePiSkillGrepToolOptions,
): PiToolDefinition {
  const markdownFileListCache = new Map<string, string[]>();

  return defineTool({
    name: 'grep',
    label: 'grep',
    description:
      '在本轮可见的 Pi Skill Markdown 文件中按关键词检索，返回命中的授权路径、行号和上下文摘要。',
    promptSnippet:
      'Use grep to search authorized Pi Skill Markdown content when the relevant file or section is unknown.',
    promptGuidelines: [
      '当已知具体 Markdown 文件时，可以直接用 read；当只知道关键词或不确定位置时，可用 grep 搜索。',
      'grep 只能搜索 <available_skills> 中授权 Skill 目录内的 Markdown 文件。',
      'path 可省略以搜索所有授权 Skill；传某个 Skill 的 SKILL.md 路径或其目录，会搜索该 Skill 的全部 Markdown（含 docs/examples 等子目录），无需逐个文件试。',
      'query 默认按正则匹配（普通关键词照常使用）；只在需要把 . * ( ) 等字符当字面查找时设 regex=false。',
    ],
    parameters: grepParamsSchema,
    executionMode: 'sequential',
    prepareArguments: normalizeParams,
    async execute(
      toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<PiSkillGrepDetails>> {
      const startedAt = Date.now();
      const query = readString(params.query) ?? '';
      const caseSensitive = readBoolean(params.caseSensitive) ?? false;
      const grepResult = await runGrepInWorker(
        params,
        options,
        markdownFileListCache,
        signal,
      );
      const regex = grepResult.regex ?? false;

      return completePiToolExecution({
        options,
        toolCallId,
        toolName: 'grep',
        params: params as Record<string, unknown>,
        output: grepResult.output,
        isError: grepResult.isError,
        traceType: 'pi_skill_grep_completed',
        startedAt,
        traceFields: {
          path: params.path,
          regex,
          total: grepResult.total,
          truncated: grepResult.truncated,
          expandedToSkillDir: grepResult.expandedToSkillDir,
          errorCode: grepResult.errorCode,
        },
        details: {
          output: grepResult.output,
          isError: grepResult.isError,
          query,
          path: params.path,
          regex,
          caseSensitive,
          matches: grepResult.matches,
          total: grepResult.total,
          totalIsExact: grepResult.totalIsExact,
          truncated: grepResult.truncated,
          searchedFiles: grepResult.searchedFiles,
          skippedLargeFiles: grepResult.skippedLargeFiles,
          expandedToSkillDir: grepResult.expandedToSkillDir,
          errorCode: grepResult.errorCode,
          error: grepResult.error,
        },
      });
    },
  });
}
