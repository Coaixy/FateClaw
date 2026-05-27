/**
 * 技能 HTTP 场景服务层。
 *
 * 当前先作为技能域统一门面，集中承接数据库与官方目录访问，
 * 后续再继续把 route 中的验证与流程编排下沉进来。
 */

import crypto from 'crypto';

import {
  createSkillBundle,
  createUserCustomSkill,
  createWithdrawalRequest,
  decryptSensitive,
  deleteSkillBundle,
  deleteUserCustomSkill,
  disableUserSkill,
  enableUserSkill,
  getAllSkillGlobalConfigs,
  getBundleByToken,
  getCreatorBundleConfig,
  getCreatorEarnings,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserById,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  getUserSkills,
  listCreatorSharedSkills,
  listMarketBundles,
  listMarketSkills,
  listUserBundles,
  listWithdrawalsForCreator,
  maskIdNumber,
  promoteUserToCreator,
  publishSkillBundle,
  publishUserCustomSkill,
  seedOfficialSkills,
  shareSkillBundle,
  shareUserCustomSkill,
  subscribeToBundle,
  subscribeToCreatorBundle,
  subscribeToSkill,
  subscribeToSkillPaid,
  toggleSubscription,
  toggleUserCustomSkill,
  unpublishSkillBundle,
  unpublishUserCustomSkill,
  unsubscribeFromSkill,
  unsubscribeFromBundle,
  unshareSkillBundle,
  unshareUserCustomSkill,
  updateSkillBundle,
  updateUserCustomSkill,
  upsertCreatorBundleConfig,
} from '../../infrastructure/db.js';
import { normalizeCategory } from './category-map.js';
import {
  loadOfficialSkillCatalog,
  type OfficialSkillCatalogEntry,
} from './skill-manifest.js';

export {
  createSkillBundle,
  createUserCustomSkill,
  createWithdrawalRequest,
  deleteSkillBundle,
  deleteUserCustomSkill,
  disableUserSkill,
  enableUserSkill,
  getAllSkillGlobalConfigs,
  getBundleByToken,
  getCreatorBundleConfig,
  getCreatorEarnings,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserById,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  getUserSkills,
  loadOfficialSkillCatalog,
  listCreatorSharedSkills,
  listMarketBundles,
  listMarketSkills,
  listUserBundles,
  listWithdrawalsForCreator,
  maskIdNumber,
  normalizeCategory,
  promoteUserToCreator,
  publishSkillBundle,
  publishUserCustomSkill,
  shareSkillBundle,
  shareUserCustomSkill,
  subscribeToBundle,
  subscribeToCreatorBundle,
  subscribeToSkill,
  subscribeToSkillPaid,
  toggleSubscription,
  toggleUserCustomSkill,
  unpublishSkillBundle,
  unpublishUserCustomSkill,
  unsubscribeFromSkill,
  unsubscribeFromBundle,
  unshareSkillBundle,
  unshareUserCustomSkill,
  updateSkillBundle,
  updateUserCustomSkill,
  upsertCreatorBundleConfig,
};

export type { OfficialSkillCatalogEntry };

export const MAX_USER_SKILLS = 30;
export const MAX_CONTENT_LENGTH = 30000;

const INTERNAL_OFFICIAL_SKILL_DIRS = new Set<string>();

export function isUserVisibleOfficialSkill(
  skill: OfficialSkillCatalogEntry,
): boolean {
  return !INTERNAL_OFFICIAL_SKILL_DIRS.has(skill.dir);
}

export function loadUserVisibleOfficialSkillCatalog(
  skillsDir?: string,
): OfficialSkillCatalogEntry[] {
  return loadOfficialSkillCatalog(skillsDir).filter(isUserVisibleOfficialSkill);
}

/**
 * 读取官方 Skill 清单，并确保数据库中已补齐对应记录。
 */
export async function getOfficialSkills(): Promise<
  OfficialSkillCatalogEntry[]
> {
  const skills = loadOfficialSkillCatalog();
  await seedOfficialSkills(skills.map((skill) => skill.name));
  return skills.filter(isUserVisibleOfficialSkill);
}

/**
 * 将技能名称转换为稳定目录名，避免路由层重复实现。
 */
export function slugifySkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '');
  return `user-${slug || crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 提现列表使用的安全解密函数。
 */
export function safeDecryptSkillSensitiveValue(encoded: string): string {
  try {
    return decryptSensitive(encoded);
  } catch {
    return '';
  }
}
