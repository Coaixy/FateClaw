import fs, { type Stats } from 'fs';
import path from 'path';

import {
  defineTool,
  type AgentToolResult,
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import type { RequestScope } from '../request-scope.js';
import type { PiToolExecutionRecord } from './types.js';

const MAX_SKILL_READ_CHARS = 40_000;

const readParamsSchema = Type.Object({
  path: Type.String({
    description: 'Pi Skill 文件的绝对路径，只能读取本轮 <available_skills> 暴露的授权 Skill 目录内文件。',
  }),
});

type ReadParams = Static<typeof readParamsSchema>;

interface PiSkillReadDetails {
  output: string;
  path?: string;
  isError: boolean;
}

export interface CreatePiSkillReadToolOptions {
  requestScope: RequestScope;
  readableSkills: Skill[];
  recordExecution(record: PiToolExecutionRecord): void;
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveReadablePath(
  rawPath: string,
  readableSkills: Skill[],
): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  return readableSkills.some((skill) =>
    isPathInside(resolved, path.resolve(skill.baseDir)),
  )
    ? resolved
    : null;
}

function toAgentToolResult(args: {
  output: string;
  path?: string;
  isError?: boolean;
}): AgentToolResult<PiSkillReadDetails> {
  return {
    content: [{ type: 'text', text: args.output }],
    details: {
      output: args.output,
      path: args.path,
      isError: Boolean(args.isError),
    },
  };
}

function readSkillFile(filePath: string): { output: string; isError: boolean } {
  let stat: Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return {
      output: `读取失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
  if (!stat.isFile()) {
    return {
      output: `路径不是文件: ${filePath}`,
      isError: true,
    };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.length <= MAX_SKILL_READ_CHARS) {
    return { output: content, isError: false };
  }
  return {
    output: `${content.slice(0, MAX_SKILL_READ_CHARS)}\n\n[已截断：Skill 文件超过 ${MAX_SKILL_READ_CHARS} 字符]`,
    isError: false,
  };
}

export function createPiSkillReadTool(
  options: CreatePiSkillReadToolOptions,
): PiToolDefinition {
  return defineTool({
    name: 'read',
    label: 'read',
    description:
      '读取本轮可见的 Pi Skill 文件。只能读取 <available_skills> 中 location 指向的授权 Skill 目录，不能读取任意本地文件。',
    promptSnippet: 'Read an authorized Pi Skill file exposed in <available_skills>.',
    promptGuidelines: [
      '只用 read 读取 <available_skills> 中 location 指向的授权 Skill 文件。',
      '可以按 SKILL.md/index.md 的相对路径指引读取同一 Skill 目录内的 Markdown 文件。',
      '不要尝试用 read 读取 .pi/skills、~/.pi/agent 或任意未列出的路径。',
    ],
    parameters: readParamsSchema,
    executionMode: 'sequential',
    prepareArguments(args): ReadParams {
      return args && typeof args === 'object' && !Array.isArray(args)
        ? (args as ReadParams)
        : { path: '' };
    },
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiSkillReadDetails>> {
      const startedAt = Date.now();
      const filePath = resolveReadablePath(params.path, options.readableSkills);
      const readResult = filePath
        ? readSkillFile(filePath)
        : {
            output: `读取被拒绝：${params.path || '(空路径)'} 不属于本轮可见官方 Pi Skill 目录。`,
            isError: true,
          };
      const isError = readResult.isError;
      const output = readResult.output;

      options.recordExecution({
        invocation: {
          id: toolCallId,
          toolName: 'read',
          args: params,
        },
        output,
        isError,
      });
      appendTranscriptEvent(options.requestScope, {
        type: 'tool_use',
        invocation: {
          id: toolCallId,
          toolName: 'read',
          args: params,
          source: 'model',
        },
      });
      appendTranscriptEvent(options.requestScope, {
        type: 'tool_result',
        invocationId: toolCallId,
        ok: !isError,
        output,
      });
      traceEvent(
        {
          type: 'pi_skill_read_completed',
          path: filePath ?? params.path,
          elapsedMs: Date.now() - startedAt,
          isError,
        },
        options.requestScope,
      );

      return toAgentToolResult({
        output,
        path: filePath ?? params.path,
        isError,
      });
    },
  });
}
