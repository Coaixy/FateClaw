import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';

import {
  queryEffectiveUserSkills,
  queryEnabledSkillNames,
  queryLatestFollowupWorkflowContext,
  querySoulContent,
  queryTasksForAccount,
  toggleUserSkill,
  updateSoulContentDb,
  type EffectiveUserSkill,
  type FollowupWorkflowContext,
  type TaskSnapshot,
} from './agent-db.js';
import { SKILLS_DIR } from './paths.js';
import type { SkillMetadata } from './skill-metadata-types.js';
import { getRedis } from './redis.js';
import { readTextSkillBundleMarkdown } from './text-skill-bundle.js';

export interface MemoryStore {
  read(accountId: string): Promise<string>;
  write(accountId: string, content: string): Promise<void>;
}

export interface SkillCatalog {
  listOfficialSkillMetadata(skillsDir?: string): SkillMetadata[];
  loadOfficialSkillContent(skillDir: string, skillsDir?: string): string | null;
  listEnabledSkillNames(userId?: string): Promise<string[]>;
  listEffectiveUserSkills(userId: string): Promise<EffectiveUserSkill[]>;
  readTextSkillBundle?(skill: EffectiveUserSkill): Promise<string>;
  toggleUserSkill(
    userId: string,
    skillName: string,
    action: 'enable' | 'disable',
  ): Promise<void>;
}

export interface TaskStore {
  list(accountId: string): Promise<TaskSnapshot[]>;
}

export interface MessageBus {
  pushOutbox(accountId: string, payload: object): Promise<void>;
  pushTask(accountId: string, payload: object): Promise<void>;
}

export interface HistoryStore {
  listRecent(accountId: string, limit: number): Promise<string[]>;
}

export interface WorkflowContextStore {
  latestFollowupContext(args: {
    accountId: string;
    category?: string;
    sessionId?: string;
  }): Promise<FollowupWorkflowContext | null>;
}

export interface SkillExecutionRequest {
  interpreter: string;
  scriptPath: string;
  args: string[];
  timeout: number;
  maxBuffer: number;
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
}

export interface SkillExecutionResult {
  stdout: string;
  stderr: string;
  errorMessage?: string;
  killed?: boolean;
}

export interface SkillExecutor {
  execute(request: SkillExecutionRequest): Promise<SkillExecutionResult>;
}

export interface AgentRuntimeDeps {
  memoryStore: MemoryStore;
  skillCatalog: SkillCatalog;
  taskStore: TaskStore;
  messageBus: MessageBus;
  historyStore: HistoryStore;
  workflowContextStore?: WorkflowContextStore;
  skillExecutor: SkillExecutor;
}

function listOfficialSkillMetadata(
  skillsDir: string = SKILLS_DIR,
): SkillMetadata[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  try {
    return loadSkillsFromDir({
      dir: skillsDir,
      source: 'fateclaw-official',
    }).skills.map((skill) => ({
      dir: path.basename(skill.baseDir),
      name: skill.name,
      description: skill.description,
      trigger: skill.description,
      type: 'official' as const,
      manifestSource: 'SKILL.md' as const,
      requiresLoad: false,
    }));
  } catch {
    return [];
  }
}

function loadOfficialSkillContent(
  skillDir: string,
  skillsDir: string = SKILLS_DIR,
): string | null {
  const skillMarkdownPath = path.join(skillsDir, skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMarkdownPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(skillMarkdownPath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

const defaultAgentRuntimeDeps: AgentRuntimeDeps = {
  memoryStore: {
    read(accountId) {
      return querySoulContent(accountId);
    },
    write(accountId, content) {
      return updateSoulContentDb(accountId, content);
    },
  },

  skillCatalog: {
    listOfficialSkillMetadata(skillsDir) {
      return listOfficialSkillMetadata(skillsDir);
    },
    loadOfficialSkillContent(skillDir, skillsDir) {
      return loadOfficialSkillContent(skillDir, skillsDir);
    },
    listEnabledSkillNames(userId) {
      return queryEnabledSkillNames(userId);
    },
    listEffectiveUserSkills(userId) {
      return queryEffectiveUserSkills(userId);
    },
    async readTextSkillBundle(skill) {
      return readTextSkillBundleMarkdown(skill.bundle_uri);
    },
    toggleUserSkill(userId, skillName, action) {
      return toggleUserSkill(userId, skillName, action);
    },
  },

  taskStore: {
    list(accountId) {
      return queryTasksForAccount(accountId);
    },
  },

  messageBus: {
    async pushOutbox(accountId, payload) {
      await getRedis().lpush(`ipc:${accountId}:outbox`, JSON.stringify(payload));
    },
    async pushTask(accountId, payload) {
      await getRedis().lpush(`ipc:${accountId}:tasks`, JSON.stringify(payload));
    },
  },

  historyStore: {
    listRecent(accountId, limit) {
      return getRedis().lrange(`history:${accountId}`, 0, limit - 1);
    },
  },

  workflowContextStore: {
    latestFollowupContext(args) {
      return queryLatestFollowupWorkflowContext(args);
    },
  },

  skillExecutor: {
    execute(request) {
      return new Promise((resolve) => {
        let settled = false;
        const settleOnce = (value: {
          stdout: string;
          stderr: string;
          errorMessage?: string;
          killed: boolean;
        }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const child = execFile(
          request.interpreter,
          [request.scriptPath, ...request.args],
          {
            timeout: request.timeout,
            maxBuffer: request.maxBuffer,
            cwd: request.cwd,
            signal: request.signal,
            env: request.env,
          },
          (error, stdout, stderr) => {
            settleOnce({
              stdout,
              stderr,
              errorMessage: error?.message,
              killed: Boolean(error && 'killed' in error && error.killed),
            });
          },
        );

        // spawn 失败（如 ENOENT / EACCES）时 'error' 事件可能先于 callback 触发，
        // 此处兜底确保 Promise 不会永远 pending 卡住外层 agent loop。
        child.on('error', (err) => {
          settleOnce({
            stdout: '',
            stderr: '',
            errorMessage: err.message,
            killed: false,
          });
        });

        if (request.stdin && child.stdin) {
          child.stdin.write(request.stdin);
          child.stdin.end();
        }
      });
    },
  },
};

export function getDefaultAgentRuntimeDeps(): AgentRuntimeDeps {
  return defaultAgentRuntimeDeps;
}

export type { EffectiveUserSkill, TaskSnapshot };
