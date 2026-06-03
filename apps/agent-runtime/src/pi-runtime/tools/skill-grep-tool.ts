import { promises as fs, type Dirent, type Stats } from 'fs';
import path from 'path';

import {
  defineTool,
  type AgentToolResult,
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import { completePiToolExecution, type PiToolRuntimeOptions } from './tool-execution.js';

const MAX_GREP_RESULTS = 80;
const DEFAULT_GREP_LIMIT = 40;
const MAX_MATCH_PREVIEW_CHARS = 220;
const MAX_FILE_BYTES = 256 * 1024;
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
    description: '要在授权 Skill Markdown 文件中查找的关键词。',
  }),
  path: Type.Optional(
    Type.String({
      description:
        '可选搜索范围；必须是 <available_skills> 中授权 Skill 目录内的 Markdown 文件或目录。相对路径按每个授权 Skill 目录解析。',
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
  caseSensitive: boolean;
  matches: GrepMatch[];
  total: number;
  totalIsExact: boolean;
  truncated: boolean;
  searchedFiles?: number;
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function normalizeLimit(value: unknown): number {
  const limit = readInteger(value) ?? DEFAULT_GREP_LIMIT;
  if (limit <= 0) return DEFAULT_GREP_LIMIT;
  return Math.min(limit, MAX_GREP_RESULTS);
}

function normalizeParams(args: unknown): GrepParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { query: '' };
  }
  const raw = args as Record<string, unknown>;
  return {
    query: readString(raw.query) ?? '',
    path: readString(raw.path),
    caseSensitive: readBoolean(raw.caseSensitive),
    limit: normalizeLimit(raw.limit),
  };
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMarkdownPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.md';
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

  const cwdCandidate = path.resolve(trimmed);
  const scopes: SearchScope[] = [];
  let sawAuthorizedCandidate = false;
  let sawUnsupportedPath = false;

  for (const skill of readableSkills) {
    const baseDir = path.resolve(skill.baseDir);
    const targetPath = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(baseDir, trimmed);
    const candidates = [targetPath, cwdCandidate];
    const seenCandidates = new Set<string>();

    for (const candidate of candidates) {
      if (seenCandidates.has(candidate)) continue;
      seenCandidates.add(candidate);
      if (!isPathInside(candidate, baseDir)) continue;
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

async function validateSearchScopes(
  scopes: SearchScope[],
): Promise<string | undefined> {
  for (const scope of scopes) {
    const stat = await safeStat(scope.targetPath);
    if (!stat) {
      return `搜索失败：路径不存在或不可访问：${scope.targetPath}`;
    }
    if (stat.isFile() && !isMarkdownPath(scope.targetPath)) {
      return `搜索被拒绝：${scope.targetPath} 不是授权 Skill 内的 Markdown 文件或目录。`;
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      return `搜索被拒绝：${scope.targetPath} 不是授权 Skill 内的 Markdown 文件或目录。`;
    }
  }
  return undefined;
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

async function grepFile(args: {
  filePath: string;
  scope: SearchScope;
  normalizedQuery: string;
  caseSensitive: boolean;
  remaining: number;
}): Promise<{ matches: GrepMatch[]; total: number; truncated: boolean }> {
  const stat = await safeStat(args.filePath);
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) {
    return { matches: [], total: 0, truncated: false };
  }

  let content: string;
  try {
    content = await fs.readFile(args.filePath, 'utf-8');
  } catch {
    return { matches: [], total: 0, truncated: false };
  }

  const matches: GrepMatch[] = [];
  let total = 0;
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const haystack = args.caseSensitive ? line : line.toLowerCase();
    const columnIndex = haystack.indexOf(args.normalizedQuery);
    if (columnIndex < 0) continue;
    total += 1;
    if (matches.length < args.remaining) {
      matches.push({
        path: args.filePath,
        relativePath: formatRelativePath(args.filePath, args.scope.baseDir),
        skill: args.scope.skill.name,
        line: index + 1,
        column: columnIndex + 1,
        text: truncateLine(line, columnIndex + 1),
      });
    } else {
      return { matches, total, truncated: true };
    }
  }
  return { matches, total, truncated: false };
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
  const validationError = params.path
    ? await validateSearchScopes(resolved.scopes)
    : undefined;
  if (validationError) {
    return {
      output: validationError,
      isError: true,
      matches: [],
      total: 0,
      totalIsExact: true,
      truncated: false,
      error: validationError,
    };
  }

  const caseSensitive = readBoolean(params.caseSensitive) ?? false;
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const limit = normalizeLimit(params.limit);
  const matches: GrepMatch[] = [];
  let total = 0;
  let searchedFiles = 0;
  let truncated = false;

  searchScopes:
  for (const scope of resolved.scopes) {
    const files = await collectMarkdownFiles(scope, cache);
    for (const filePath of files) {
      searchedFiles += 1;
      const fileResult = await grepFile({
        filePath,
        scope,
        normalizedQuery,
        caseSensitive,
        remaining: Math.max(0, limit - matches.length),
      });
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

  const output = JSON.stringify(
    {
      query,
      path: params.path,
      caseSensitive,
      searchedFiles,
      total,
      totalIsExact: !truncated,
      truncated,
      matches,
    },
    null,
    2,
  );
  return {
    output,
    isError: false,
    matches,
    total,
    totalIsExact: !truncated,
    truncated,
    searchedFiles,
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
          total: grepResult.total,
          truncated: grepResult.truncated,
        },
        details: {
          output: grepResult.output,
          isError: grepResult.isError,
          query,
          path: params.path,
          caseSensitive,
          matches: grepResult.matches,
          total: grepResult.total,
          totalIsExact: grepResult.totalIsExact,
          truncated: grepResult.truncated,
          searchedFiles: grepResult.searchedFiles,
          error: grepResult.error,
        },
      });
    },
  });
}
