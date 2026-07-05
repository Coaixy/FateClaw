import {
  queryEffectiveUserSkills,
  queryEffectiveUserSkillsByIds,
  querySoulEditEnabled,
  querySoulContent,
  updateSoulContentDb,
  type EffectiveUserSkill,
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
  canEdit(accountId: string): Promise<boolean>;
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
  /** 按单个 Skill id 读取用户有效 Skill（归属+启用校验在内部完成）；对外开放 API 用。 */
  listEffectiveUserSkillsByIds?(
    userId: string,
    skillIds: string[],
  ): Promise<EffectiveUserSkill[]>;
}

/**
 * 单次 Agent Runtime 请求依赖集合。
 *
 * 注意：这些依赖是运行时边界，测试可注入替身；生产默认实现直连数据库。
 */
export interface AgentRuntimeDeps {
  soulStore: SoulStore;
  skillCatalog: SkillCatalog;
}

const defaultAgentRuntimeDeps: AgentRuntimeDeps = {
  soulStore: {
    read(accountId) {
      return querySoulContent(accountId);
    },
    canEdit(accountId) {
      return querySoulEditEnabled(accountId);
    },
    update(accountId, content) {
      return updateSoulContentDb(accountId, content);
    },
  },

  skillCatalog: {
    listEffectiveUserSkills(userId) {
      return queryEffectiveUserSkills(userId);
    },
    listEffectiveUserSkillsByIds(userId, skillIds) {
      return queryEffectiveUserSkillsByIds(userId, skillIds);
    },
  },
};

/**
 * 获取生产默认 Agent Runtime 依赖。
 *
 * @returns 默认依赖集合。
 * @remarks 默认实现会直连数据库读取 Soul 和 Skill。
 */
export function getDefaultAgentRuntimeDeps(): AgentRuntimeDeps {
  return defaultAgentRuntimeDeps;
}

export type { EffectiveUserSkill };
