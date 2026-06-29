import fs, { type Stats } from 'fs';

import {
  defineTool,
  type AgentToolResult,
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import { completePiToolExecution, type PiToolRuntimeOptions } from './tool-execution.js';
import {
  isMarkdownPath,
  resolveSkillPathCandidates,
} from './skill-path.js';

const MAX_SKILL_READ_LINES = 2_000;
const MAX_SKILL_READ_BYTES = 50 * 1024;

const readParamsSchema = Type.Object({
  path: Type.String({
    description:
      'Pi Skill Markdown 文件路径；可使用 <available_skills> 中的绝对路径，也可读取同一 Skill 目录内的相对 Markdown 路径。',
  }),
  offset: Type.Optional(
    Type.Number({
      description: '从第几行开始读取，1 表示第一行。',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: '最多读取多少行；超过工具上限时会自动截断并提示下一次 offset。',
    }),
  ),
});

type ReadParams = Static<typeof readParamsSchema>;

interface PiSkillReadDetails {
  output: string;
  path?: string;
  isError: boolean;
  offset?: number;
  limit?: number;
  totalLines?: number;
  nextOffset?: number;
}

/**
 * 创建 Skill read 工具所需的依赖。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - readableSkills：本轮请求授权给 Pi 读取的 Skill 清单。
 * - recordExecution：工具执行记录回调。
 *
 * 注意：read 只能读取授权 Skill 目录内的 Markdown 文件。
 */
export interface CreatePiSkillReadToolOptions extends PiToolRuntimeOptions {
  readableSkills: Skill[];
}

function resolveReadablePath(
  rawPath: string,
  readableSkills: Skill[],
): { filePath?: string; error?: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return {
      error: '读取被拒绝：(空路径) 不是本轮可见 Skill 内的 Markdown 文件。',
    };
  }

  // 取第一个落在某个授权 Skill 边界内的候选；非 Markdown 直接拒绝。
  for (const { candidates } of resolveSkillPathCandidates(
    trimmed,
    readableSkills,
  )) {
    for (const candidate of candidates) {
      if (!isMarkdownPath(candidate)) {
        return {
          error: `读取被拒绝：${rawPath} 不是授权 Skill 内的 Markdown 文件。`,
        };
      }
      return { filePath: candidate };
    }
  }

  return {
    error: `读取被拒绝：${rawPath} 不属于本轮可见 Skill 目录。`,
  };
}

function normalizePositiveInteger(
  value: number | undefined,
): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function readSkillFile(
  filePath: string,
  params: ReadParams,
): {
  output: string;
  isError: boolean;
  offset?: number;
  limit?: number;
  totalLines?: number;
  nextOffset?: number;
} {
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
  const lines = content.split('\n');
  const totalLines = lines.length;
  const offset = normalizePositiveInteger(params.offset) ?? 1;
  const requestedLimit = normalizePositiveInteger(params.limit);
  const lineLimit = Math.min(
    requestedLimit ?? MAX_SKILL_READ_LINES,
    MAX_SKILL_READ_LINES,
  );
  const startIndex = offset - 1;

  if (startIndex >= totalLines) {
    return {
      output: `读取失败: offset=${offset} 超出文件末尾（共 ${totalLines} 行）`,
      isError: true,
      offset,
      limit: requestedLimit,
      totalLines,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let stoppedBy: 'limit' | 'lines' | 'bytes' | null = null;
  for (
    let index = startIndex;
    index < totalLines && outputLines.length < lineLimit;
    index += 1
  ) {
    const line = lines[index] ?? '';
    const lineBytes =
      Buffer.byteLength(line, 'utf-8') + (outputLines.length > 0 ? 1 : 0);
    if (lineBytes > MAX_SKILL_READ_BYTES && outputLines.length === 0) {
      return {
        output: [
          `[第 ${offset} 行超过 ${formatSize(MAX_SKILL_READ_BYTES)} 限制，无法安全展示。]`,
          offset < totalLines
            ? `[可使用 offset=${offset + 1} 跳过该行继续读取。]`
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
        isError: false,
        offset,
        limit: requestedLimit,
        totalLines,
        nextOffset: offset < totalLines ? offset + 1 : undefined,
      };
    }
    if (outputBytes + lineBytes > MAX_SKILL_READ_BYTES) {
      stoppedBy = 'bytes';
      break;
    }
    outputLines.push(line);
    outputBytes += lineBytes;
  }

  if (!stoppedBy && outputLines.length >= lineLimit) {
    stoppedBy =
      requestedLimit && requestedLimit <= MAX_SKILL_READ_LINES
        ? 'limit'
        : 'lines';
  }

  const endLine = offset + outputLines.length - 1;
  const nextOffset = endLine < totalLines ? endLine + 1 : undefined;
  const output = outputLines.join('\n');
  const continuationMessage =
    stoppedBy === 'bytes'
      ? `[Showing lines ${offset}-${endLine} of ${totalLines} (${formatSize(MAX_SKILL_READ_BYTES)} limit). Use offset=${nextOffset} to continue.]`
      : stoppedBy === 'lines'
        ? `[Showing lines ${offset}-${endLine} of ${totalLines} (${MAX_SKILL_READ_LINES} line limit). Use offset=${nextOffset} to continue.]`
        : `[Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
  const continuation = nextOffset ? `\n\n${continuationMessage}` : '';

  return {
    output: `${output}${continuation}`,
    isError: false,
    offset,
    limit: requestedLimit,
    totalLines,
    nextOffset,
  };
}

/**
 * 创建 Pi 的授权 Skill Markdown 读取工具。
 *
 * 参数：CreatePiSkillReadToolOptions。
 * 返回：可注册到 Pi customTools 的 read 工具定义。
 * 注意：该工具会拒绝读取未授权路径和非 Markdown 文件。
 */
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
      const resolvedPath = resolveReadablePath(
        params.path,
        options.readableSkills,
      );
      const filePath = resolvedPath.filePath;
      const readResult = filePath
        ? readSkillFile(filePath, params)
        : {
            output:
              resolvedPath.error ??
              `读取被拒绝：${params.path || '(空路径)'} 不属于本轮可见 Skill 目录。`,
            isError: true,
          };
      const isError = readResult.isError;
      const output = readResult.output;

      return completePiToolExecution({
        options,
        toolCallId,
        toolName: 'read',
        params: params as Record<string, unknown>,
        output,
        isError,
        traceType: 'pi_skill_read_completed',
        startedAt,
        traceFields: {
          path: filePath ?? params.path,
        },
        details: {
          output,
          path: filePath ?? params.path,
          isError,
          offset: readResult.offset,
          limit: readResult.limit,
          totalLines: readResult.totalLines,
          nextOffset: readResult.nextOffset,
        },
      });
    },
  });
}
