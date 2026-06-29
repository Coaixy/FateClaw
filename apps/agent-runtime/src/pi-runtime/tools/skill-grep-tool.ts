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

/** 生成字面子串匹配器；caseSensitive=false 时双方转小写。 */
function literalMatcher(query: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? query : query.toLowerCase();
  return (line) =>
    (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
}

/**
 * 把 query 编译成逐行匹配器。
 *
 * - regex=true（默认）：编译为 JavaScript 正则（caseSensitive=false 时附加 i 标志）；
 *   普通关键词不含元字符时等价子串匹配。正则非法时**自动回退字面子串**，并标记 usedRegex=false。
 * - regex=false：强制字面子串匹配。
 *
 * 返回：matcher 与 usedRegex（实际是否按正则匹配；强制字面或非法回退时为 false，供结果标注）。
 * 注意：正则由模型提供并逐行执行，单行规模受文件大小安全阀约束，灾难性回溯风险有限但非零；
 *       这里不对单行做额外超时保护，仅依赖上层 MAX_FILE_BYTES 兜底。
 */
function buildMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): { matcher: LineMatcher; usedRegex: boolean } {
  if (regex) {
    try {
      const compiled = new RegExp(query, caseSensitive ? '' : 'i');
      return {
        // 非 global 正则，exec 每次从行首匹配，无 lastIndex 残留状态。
        matcher: (line) => {
          const match = compiled.exec(line);
          return match ? match.index : -1;
        },
        usedRegex: true,
      };
    } catch {
      // 正则非法：退化为字面子串，保证仍能给出结果而非报错或空（grep -E 退回 grep -F 的语义）。
    }
  }
  return { matcher: literalMatcher(query, caseSensitive), usedRegex: false };
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
  regex?: boolean;
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
  // 默认按正则匹配（不传 regex 即视为 true）；非法正则在 buildMatcher 内自动回退字面。
  const wantRegex = readBoolean(params.regex) ?? true;
  const { matcher, usedRegex } = buildMatcher(query, wantRegex, caseSensitive);
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
    regex: usedRegex,
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
    regex: usedRegex,
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
      'query 默认按正则匹配（普通关键词照常使用）；只在需要把 . * ( ) 等字符当字面查找时设 regex=false。',
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
      const caseSensitive = readBoolean(params.caseSensitive) ?? false;
      const grepResult = await runGrep(
        params,
        options.readableSkills,
        markdownFileListCache,
      );
      // 实际匹配模式（正则 / 非法回退字面）由 runGrep 决定，用于 trace 与 details 标注。
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
