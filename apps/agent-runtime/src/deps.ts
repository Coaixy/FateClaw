import {
  queryEffectiveUserSkills,
  queryLatestFollowupWorkflowContext,
  querySoulContent,
  updateSoulContentDb,
  type EffectiveUserSkill,
  type FollowupWorkflowContext,
} from './agent-db.js';

/**
 * 用户 Soul 读写存储。
 *
 * 参数：
 * - accountId：当前 agent-runtime 账号 ID。
 *
 * 返回：read 返回 Dashboard 维护的唯一 Soul 内容；update 无返回值。
 * 注意：实现层负责处理 web:{userId} 和微信账号的归属映射。
 */
export interface SoulStore {
  read(accountId: string): Promise<string>;
  update(accountId: string, content: string): Promise<void>;
}

/**
 * 当前用户可见 Skill 目录。
 *
 * 参数：
 * - userId：平台用户 ID。
 *
 * 返回：用户自有和订阅的有效 Skill 清单。
 * 注意：这里只暴露请求级授权资源，不代表全局本地 Skill 可见。
 */
export interface SkillCatalog {
  listEffectiveUserSkills(userId: string): Promise<EffectiveUserSkill[]>;
}

/**
 * 业务连续性上下文存储。
 *
 * 参数：
 * - accountId：当前 agent-runtime 账号 ID。
 * - category：可选业务分类。
 * - sessionId：可选会话 ID。
 *
 * 返回：最近一次可用于追问续接的业务 artifact 上下文；不存在时返回 null。
 */
export interface WorkflowContextStore {
  latestFollowupContext(args: {
    accountId: string;
    category?: string;
    sessionId?: string;
  }): Promise<FollowupWorkflowContext | null>;
}

/**
 * 单次 Agent Runtime 请求依赖集合。
 *
 * 注意：这些依赖是运行时边界，测试可注入替身；生产默认实现直连数据库。
 */
export interface AgentRuntimeDeps {
  soulStore: SoulStore;
  skillCatalog: SkillCatalog;
  workflowContextStore?: WorkflowContextStore;
}

const defaultAgentRuntimeDeps: AgentRuntimeDeps = {
  soulStore: {
    read(accountId) {
      return querySoulContent(accountId);
    },
    update(accountId, content) {
      return updateSoulContentDb(accountId, content);
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

/**
 * 获取生产默认 Agent Runtime 依赖。
 *
 * @returns 默认依赖集合。
 * @remarks 默认实现会直连数据库读取 Soul、Skill 和连续性上下文。
 */
export function getDefaultAgentRuntimeDeps(): AgentRuntimeDeps {
  return defaultAgentRuntimeDeps;
}

export type { EffectiveUserSkill };
