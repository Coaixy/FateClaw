import {
  createReadStream,
  promises as fs,
  type Dirent,
  type Stats,
} from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

import {
  clampLimit,
  readBoolean,
  readString,
  toJsonOutput,
} from './param-utils.ts';
import { isMarkdownPath, resolveSkillPathCandidates } from './skill-path.ts';
import {
  DEFAULT_GREP_LIMIT,
  MAX_GREP_RESULTS,
  type GrepMatch,
  type SkillGrepParams,
  type SkillGrepResult,
  type SkillGrepWorkerInput,
} from './skill-grep-protocol.ts';

const MAX_MATCH_PREVIEW_CHARS = 220;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
]);

interface SearchScope {
  skill: SkillGrepWorkerInput['readableSkills'][number];
  baseDir: string;
  targetPath: string;
  // The prompt exposes SKILL.md as an anchor for searching its sibling Markdown files.
  expandedFromFile?: string;
}

type MarkdownFileListCache = Map<string, string[]>;

function isSkippedDir(name: string): boolean {
  return SKIPPED_DIRS.has(name) || name.startsWith('.');
}

async function resolveSearchScopes(
  rawPath: string | undefined,
  readableSkills: SkillGrepWorkerInput['readableSkills'],
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
    return {
      error:
        '搜索被拒绝：(空路径) 不是本轮可见 Skill 内的 Markdown 文件或目录。',
    };
  }

  const scopes: SearchScope[] = [];
  let sawAuthorizedCandidate = false;
  let sawUnsupportedPath = false;

  for (const { skill, baseDir, candidates } of resolveSkillPathCandidates(
    trimmed,
    readableSkills,
  )) {
    for (const candidate of candidates) {
      sawAuthorizedCandidate = true;

      const stat = await safeStat(candidate);
      if (!stat) continue;
      if (stat.isFile()) {
        if (!isMarkdownPath(candidate)) {
          sawUnsupportedPath = true;
          continue;
        }
        // A file path selects its owning Skill, matching the directory search contract.
        scopes.push({
          skill,
          baseDir,
          targetPath: baseDir,
          expandedFromFile: candidate,
        });
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
  const files = await collectMarkdownFilesUncached(scope);
  cache.set(key, files);
  return files;
}

function formatRelativePath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath) || path.basename(filePath);
}

function truncateLine(line: string, column: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_MATCH_PREVIEW_CHARS) return trimmed;
  const queryIndex = Math.max(0, column - 1);
  const half = Math.floor(MAX_MATCH_PREVIEW_CHARS / 2);
  const start = Math.max(
    0,
    Math.min(queryIndex - half, trimmed.length - MAX_MATCH_PREVIEW_CHARS),
  );
  const end = Math.min(trimmed.length, start + MAX_MATCH_PREVIEW_CHARS);
  return [
    start > 0 ? '...' : '',
    trimmed.slice(start, end),
    end < trimmed.length ? '...' : '',
  ].join('');
}

type LineMatcher = (line: string) => number;

function literalMatcher(query: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? query : query.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
}

// Compile in the isolated worker so backtracking cannot block the daemon thread.
export function buildMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): { matcher: LineMatcher; usedRegex: boolean } {
  if (regex) {
    try {
      const compiled = new RegExp(query, caseSensitive ? '' : 'i');
      return {
        matcher: (line) => {
          const match = compiled.exec(line);
          return match ? match.index : -1;
        },
        usedRegex: true,
      };
    } catch {
      // Invalid patterns retain the tool's literal-search fallback.
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
  if (stat.size > MAX_FILE_BYTES) {
    return { matches: [], total: 0, truncated: false, skippedLarge: true };
  }

  const matches: GrepMatch[] = [];
  let total = 0;
  let truncated = false;
  let lineNo = 0;
  const input = createReadStream(args.filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input,
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
        truncated = true;
        break;
      }
    }
  } catch {
    return { matches, total, truncated: false, skippedLarge: false };
  } finally {
    rl.close();
    input.destroy();
  }
  return { matches, total, truncated, skippedLarge: false };
}

export async function runGrep(
  params: SkillGrepParams,
  readableSkills: SkillGrepWorkerInput['readableSkills'],
  cache: Map<string, string[]>,
): Promise<SkillGrepResult> {
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
      resolved.error ??
      `搜索被拒绝：${params.path || '(空路径)'} 不属于本轮可见 Skill 目录。`;
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
  const expandedSkillNames = [
    ...new Set(
      resolved.scopes
        .filter((scope) => scope.expandedFromFile)
        .map((scope) => scope.skill.name),
    ),
  ];
  const expandedToSkillDir = expandedSkillNames.length > 0;
  const caseSensitive = readBoolean(params.caseSensitive) ?? false;
  const wantRegex = readBoolean(params.regex) ?? true;
  const { matcher, usedRegex } = buildMatcher(query, wantRegex, caseSensitive);
  const limit = clampLimit(params.limit, DEFAULT_GREP_LIMIT, MAX_GREP_RESULTS);
  const matches: GrepMatch[] = [];
  let total = 0;
  let searchedFiles = 0;
  let skippedLargeFiles = 0;
  let truncated = false;

  searchScopes: for (const scope of resolved.scopes) {
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

  const expansionNote = expandedToSkillDir
    ? `path 指向单个文件，已自动把检索范围扩展到所属 Skill 的整个目录（${expandedSkillNames.join('、')}），以覆盖 docs/examples 等兄弟 Markdown。若只想搜某个文件，请用更精确的 query，或改用 read 直接读取。`
    : undefined;
  const output = toJsonOutput({
    query,
    path: params.path,
    regex: usedRegex,
    caseSensitive,
    searchedFiles,
    skippedLargeFiles: skippedLargeFiles || undefined,
    note: expansionNote,
    total,
    totalIsExact: !truncated,
    truncated,
    matches,
  });
  return {
    output,
    isError: false,
    regex: usedRegex,
    expandedToSkillDir,
    matches,
    total,
    totalIsExact: !truncated,
    truncated,
    searchedFiles,
    skippedLargeFiles,
  };
}
