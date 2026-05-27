import {
  queryEffectiveUserSkills,
  queryLatestFollowupWorkflowContext,
  querySoulContent,
  type EffectiveUserSkill,
  type FollowupWorkflowContext,
} from './agent-db.js';

export interface MemoryStore {
  read(accountId: string): Promise<string>;
}

export interface SkillCatalog {
  listEffectiveUserSkills(userId: string): Promise<EffectiveUserSkill[]>;
}

export interface WorkflowContextStore {
  latestFollowupContext(args: {
    accountId: string;
    category?: string;
    sessionId?: string;
  }): Promise<FollowupWorkflowContext | null>;
}

export interface AgentRuntimeDeps {
  memoryStore: MemoryStore;
  skillCatalog: SkillCatalog;
  workflowContextStore?: WorkflowContextStore;
}

const defaultAgentRuntimeDeps: AgentRuntimeDeps = {
  memoryStore: {
    read(accountId) {
      return querySoulContent(accountId);
    },
  },

  skillCatalog: {
    listEffectiveUserSkills(userId) {
      return queryEffectiveUserSkills(userId);
    },
  },

  workflowContextStore: {
    latestFollowupContext(args) {
      return queryLatestFollowupWorkflowContext(args);
    },
  },
};

export function getDefaultAgentRuntimeDeps(): AgentRuntimeDeps {
  return defaultAgentRuntimeDeps;
}

export type { EffectiveUserSkill };
