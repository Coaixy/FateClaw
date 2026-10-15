export const MAX_GREP_RESULTS = 80;
export const DEFAULT_GREP_LIMIT = 40;
export const SKILL_GREP_TIMEOUT_MS = 2_000;

export interface SkillGrepParams {
  query: string;
  path?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  limit?: number;
}

export interface GrepMatch {
  path: string;
  relativePath: string;
  skill: string;
  line: number;
  column: number;
  text: string;
}

export interface SkillGrepResult {
  output: string;
  isError: boolean;
  regex?: boolean;
  expandedToSkillDir?: boolean;
  matches: GrepMatch[];
  total: number;
  totalIsExact: boolean;
  truncated: boolean;
  searchedFiles?: number;
  skippedLargeFiles?: number;
  error?: string;
  errorCode?:
    | 'skill_grep_timeout'
    | 'skill_grep_cancelled'
    | 'skill_grep_failed';
}

export interface SkillGrepWorkerInput {
  params: SkillGrepParams;
  readableSkills: Array<{ name: string; baseDir: string }>;
  fileLists: Map<string, string[]>;
}

export interface SkillGrepWorkerOutput {
  result: SkillGrepResult;
  fileLists: Map<string, string[]>;
}
