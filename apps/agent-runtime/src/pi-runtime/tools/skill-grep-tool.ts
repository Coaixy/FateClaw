import { createReadStream, promises as fs, type Dirent, type Stats } from 'fs';
import readline from 'node:readline';
import path from 'path';

import {
  defineTool,
  type AgentToolResult,
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import { completePiToolExecution, type PiToolRuntimeOptions } from './tool-execution.js';
import {
  clampLimit,
  readBoolean,
  readString,
  toJsonOutput,
} from './param-utils.js';
import {
  isMarkdownPath,
  resolveSkillPathCandidates,
} from './skill-path.js';

const MAX_GREP_RESULTS = 80;
const DEFAULT_GREP_LIMIT = 40;
const MAX_MATCH_PREVIEW_CHARS = 220;
// grep 改用流式逐行读取，不把整文件载入内存；此处仅作单文件大小安全阀：超过则跳过并上报，
// 避免病态超大文件拖垮逐行匹配（尤其正则）。8MB 足以覆盖正常 Skill Markdown 知识库。
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
]);

const grepParamsSchema = Type.Object({
  query: Type.String({
    description:
      '要在授权 Skill Markdown 文件中查找的内容；默认按字面子串匹配，regex=true 时按 JavaScript 正则表达式匹配。',
  }),
  path: Type.Optional(
    Type.String({
      description:
        '可选搜索范围；必须是 <available_skills> 中授权 Skill 目录内的 Markdown 文件或目录。相对路径按每个授权 Skill 目录解析。',
    }),
  ),
  regex: Type.Optional(
    Type.Boolean({
      description:
        '是否把 query 当作 JavaScript 正则表达式匹配；默认 false（字面子串）。需要模式匹配（如 “甲.{0,4}流年”、行首 ^、择一 a|b）时设为 true。',
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

type GrepParams = Static<typeof grepParamsSchema>;

interface GrepMatch {
  path: string;
  relativePath: string;
  skill: string;
  line: number;
  column: number;
  text: string;
}

interface SearchScope {
  skill: Skill;
  baseDir: string;
  targetPath: string;
}

type MarkdownFileListCache = Map<string, Promise<string[]>>;

interface PiSkillGrepDetails {
  output: string;
  isError: boolean;
  query: string;
  path?: string;
  regex: boolean;
  caseSensitive: boolean;
  matches: GrepMatch[];
  total: number;
  totalIsExact: boolean;
  truncated: boolean;
  searchedFiles?: number;
  skippedLargeFiles?: number;
  error?: string;
}

/**
 * 创建 Skill grep 工具所需的依赖。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - readableSkills：本轮请求授权给 Pi 读取和检索的 Skill 清单。
 * - recordExecution：工具执行记录回调。
 *
 * 注意：grep 与 read 使用同一授权边界，只检索授权 Skill 目录内的 Markdown 文件。
 */
export interface CreatePiSkillGrepToolOptions extends PiToolRuntimeOptions {
  readableSkills: Skill[];
}

function normalizeParams(args: unknown): GrepParams {
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

function isSkippedDir(name: string): boolean {
  return SKIPPED_DIRS.has(name) || name.startsWith('.');
}

async function resolveSearchScopes(
  rawPath: string | undefined,
  readableSkills: Skill[],
): Promise<{ scopes?: SearchScope[]; error?: string }> {
  if (!rawPath) {
    return {
      scopes: readableSkills.map((skill) => ({
        skill,
        baseDir: path.resolve(skill.baseDir),
        targetPath: path.resolve(skill.baseDir),
      })),
    };
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { error: '搜索被拒绝：(空路径) 不是本轮可见 Skill 内的 Markdown 文件或目录。' };
  }

  const scopes: SearchScope[] = [];
  let sawAuthorizedCandidate = false;
  let sawUnsupportedPath = false;

  for (const { skill, baseDir, candidates } of resolveSkillPathCandidates(
    trimmed,
    readableSkills,
  )) {
    for (const candidate of candidates) {
      // resolveSkillPathCandidates 已保证 candidate 在 baseDir 边界内。
      sawAuthorizedCandidate = true;

      const stat = await safeStat(candidate);
      if (!stat) continue;
      if (stat.isFile()) {
        if (!isMarkdownPath(candidate)) {
          sawUnsupportedPath = true;
          continue;
        }
        scopes.push({ skill, baseDir, targetPath: candidate });
        break;
      }
      if (stat.isDirectory()) {
        scopes.push({ skill, baseDir, targetPath: candidate });
        break;
      }
      sawUnsupportedPath = true;
    }
  }

  if (scopes.length > 0) {
    return { scopes };
  }

  if (!sawAuthorizedCandidate) {
    return { error: `搜索被拒绝：${rawPath} 不属于本轮可见 Skill 目录。` };
  }

  if (sawUnsupportedPath) {
    return {
      error: `搜索被拒绝：${rawPath} 不是授权 Skill 内的 Markdown 文件或目录。`,
    };
  }

  return { error: `搜索失败：路径不存在或不可访问：${rawPath}` };
}

async function safeStat(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

async function collectMarkdownFilesUncached(
  scope: SearchScope,
): Promise<string[]> {
  const stat = await safeStat(scope.targetPath);
  if (!stat) return [];
  if (stat.isFile()) {
    return isMarkdownPath(scope.targetPath) ? [scope.targetPath] : [];
  }
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const pending = [scope.targetPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) {
          pending.push(entryPath);
        }
        continue;
      }
      if (entry.isFile() && isMarkdownPath(entryPath)) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

function markdownFileListCacheKey(scope: SearchScope): string {
  return `${scope.baseDir}\0${scope.targetPath}`;
}

async function collectMarkdownFiles(
  scope: SearchScope,
  cache: MarkdownFileListCache,
): Promise<string[]> {
  const key = markdownFileListCacheKey(scope);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = collectMarkdownFilesUncached(scope);
  cache.set(key, promise);
  return promise;
}

function formatRelativePath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath) || path.basename(filePath);
}

function truncateLine(line: string, column: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_MATCH_PREVIEW_CHARS) return trimmed;
  const queryIndex = Math.max(0, column - 1);
  const half = Math.floor(MAX_MATCH_PREVIEW_CHARS / 2);
  const start = Math.max(0, Math.min(queryIndex - half, trimmed.length - MAX_MATCH_PREVIEW_CHARS));
  const end = Math.min(trimmed.length, start + MAX_MATCH_PREVIEW_CHARS);
  return [
    start > 0 ? '...' : '',
    trimmed.slice(start, end),
    end < trimmed.length ? '...' : '',
  ].join('');
}

/** 行匹配器：返回命中起始列（0-based），未命中返回 -1。 */
type LineMatcher = (line: string) => number;

/**
 * 把 query 编译成逐行匹配器。
 *
 * - regex=false：字面子串匹配（indexOf）；caseSensitive=false 时双方转小写。
 * - regex=true：编译为 JavaScript 正则；caseSensitive=false 时附加 i 标志。
 *
 * 返回：成功时给出 matcher，正则非法时给出 error（由调用方转成 isError 结果）。
 * 注意：正则由模型提供并逐行执行，单行规模受文件大小安全阀约束，灾难性回溯风险有限但非零；
 *       这里不对单行做额外超时保护，仅依赖上层 MAX_FILE_BYTES 兜底。
 */
function buildMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): { matcher?: LineMatcher; error?: string } {
  if (regex) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (err) {
      return {
        error: `搜索失败：正则表达式无效：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      // 非 global 正则，exec 每次从行首匹配，无 lastIndex 残留状态。
      matcher: (line) => {
        const match = compiled.exec(line);
        return match ? match.index : -1;
      },
    };
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return {
    matcher: (line) => {
      const haystack = caseSensitive ? line : line.toLowerCase();
      return haystack.indexOf(needle);
    },
  };
}

async function grepFile(args: {
  filePath: string;
  scope: SearchScope;
  matcher: LineMatcher;
  remaining: number;
}): Promise<{
  matches: GrepMatch[];
  total: number;
  truncated: boolean;
  skippedLarge: boolean;
}> {
  const stat = await safeStat(args.filePath);
  if (!stat?.isFile()) {
    return { matches: [], total: 0, truncated: false, skippedLarge: false };
  }
  // 超过安全阀的单文件跳过，但不再静默：上报 skippedLarge，让“查无此词”可与“文件太大没搜”区分。
  if (stat.size > MAX_FILE_BYTES) {
    return { matches: [], total: 0, truncated: false, skippedLarge: true };
  }

  const matches: GrepMatch[] = [];
  let total = 0;
  let truncated = false;
  let lineNo = 0;
  // 流式逐行读取，避免把大文件整体载入内存；crlfDelay=Infinity 让 \r\n 按单个换行处理。
  const rl = readline.createInterface({
    input: createReadStream(args.filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      lineNo += 1;
      const columnIndex = args.matcher(line);
      if (columnIndex < 0) continue;
      total += 1;
      if (matches.length < args.remaining) {
        matches.push({
          path: args.filePath,
          relativePath: formatRelativePath(args.filePath, args.scope.baseDir),
          skill: args.scope.skill.name,
          line: lineNo,
          column: columnIndex + 1,
          text: truncateLine(line, columnIndex + 1),
        });
      } else {
        // 命中已填满本文件配额：标记截断并停止读取后续行。
        truncated = true;
        break;
      }
    }
  } catch {
    // 读取中途失败（IO/权限）：返回已收集的命中，按未截断处理。
    return { matches, total, truncated: false, skippedLarge: false };
  } finally {
    rl.close();
  }
  return { matches, total, truncated, skippedLarge: false };
}

async function runGrep(
  params: GrepParams,
  readableSkills: Skill[],
  cache: MarkdownFileListCache,
): Promise<{
  output: string;
  isError: boolean;
  matches: GrepMatch[];
  total: number;
  totalIsExact: boolean;
  truncated: boolean;
  searchedFiles?: number;
  skippedLargeFiles?: number;
  error?: string;
}> {
  const query = readString(params.query);
  if (!query) {
    return {
      output: '搜索失败：query 不能为空。',
      isError: true,
      matches: [],
      total: 0,
      totalIsExact: true,
      truncated: false,
      error: '搜索失败：query 不能为空。',
    };
  }

  const resolved = await resolveSearchScopes(params.path, readableSkills);
  if (!resolved.scopes) {
    const error =
      resolved.error ?? `搜索被拒绝：${params.path || '(空路径)'} 不属于本轮可见 Skill 目录。`;
    return {
      output: error,
      isError: true,
      matches: [],
      total: 0,
      totalIsExact: true,
      truncated: false,
      error,
    };
  }
  const caseSensitive = readBoolean(params.caseSensitive) ?? false;
  const useRegex = readBoolean(params.regex) ?? false;
  const built = buildMatcher(query, useRegex, caseSensitive);
  if (!built.matcher) {
    const error = built.error ?? '搜索失败：无法解析查询。';
    return {
      output: error,
      isError: true,
      matches: [],
      total: 0,
      totalIsExact: true,
      truncated: false,
      error,
    };
  }
  const matcher = built.matcher;
  const limit = clampLimit(params.limit, DEFAULT_GREP_LIMIT, MAX_GREP_RESULTS);
  const matches: GrepMatch[] = [];
  let total = 0;
  let searchedFiles = 0;
  let skippedLargeFiles = 0;
  let truncated = false;

  searchScopes:
  for (const scope of resolved.scopes) {
    const files = await collectMarkdownFiles(scope, cache);
    for (const filePath of files) {
      searchedFiles += 1;
      const fileResult = await grepFile({
        filePath,
        scope,
        matcher,
        remaining: Math.max(0, limit - matches.length),
      });
      if (fileResult.skippedLarge) {
        skippedLargeFiles += 1;
      }
      total += fileResult.total;
      if (matches.length < limit) {
        matches.push(...fileResult.matches.slice(0, limit - matches.length));
      }
      if (fileResult.truncated) {
        truncated = true;
        break searchScopes;
      }
    }
  }

  const output = toJsonOutput({
    query,
    path: params.path,
    regex: useRegex,
    caseSensitive,
    searchedFiles,
    // 0 时省略，避免给模型噪音；非 0 时提示有文件因超过 8MB 安全阀未被检索。
    skippedLargeFiles: skippedLargeFiles || undefined,
    total,
    totalIsExact: !truncated,
    truncated,
    matches,
  });
  return {
    output,
    isError: false,
    matches,
    total,
    totalIsExact: !truncated,
    truncated,
    searchedFiles,
    skippedLargeFiles,
  };
}

/**
 * 创建 Pi 的授权 Skill Markdown 检索工具。
 *
 * 参数：CreatePiSkillGrepToolOptions。
 * 返回：可注册到 Pi customTools 的 grep 工具定义。
 * 注意：该工具只返回命中摘要；需要完整上下文时应再调用 read 按路径和行号附近读取。
 */
export function createPiSkillGrepTool(
  options: CreatePiSkillGrepToolOptions,
): PiToolDefinition {
  const markdownFileListCache: MarkdownFileListCache = new Map();

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
      'path 可省略以搜索所有授权 Skill；也可指定授权目录内的相对 Markdown 文件或目录。',
    ],
    parameters: grepParamsSchema,
    executionMode: 'sequential',
    prepareArguments: normalizeParams,
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiSkillGrepDetails>> {
      const startedAt = Date.now();
      const query = readString(params.query) ?? '';
      const regex = readBoolean(params.regex) ?? false;
      const caseSensitive = readBoolean(params.caseSensitive) ?? false;
      const grepResult = await runGrep(
        params,
        options.readableSkills,
        markdownFileListCache,
      );

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
          error: grepResult.error,
        },
      });
    },
  });
}
