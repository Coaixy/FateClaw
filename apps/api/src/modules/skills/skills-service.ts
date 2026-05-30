/**
 * 技能 HTTP 场景服务层。
 *
 * 当前先作为技能域统一门面，集中承接数据库与系统排盘注册表访问，
 * 后续再继续把 route 中的验证与流程编排下沉进来。
 */

import crypto from 'crypto';

import {
  createSkillBundle,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getBundleByToken,
  getCreatorBundleConfig,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listCreatorSharedSkills,
  listMarketBundles,
  listMarketSkills,
  listUserBundles,
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
} from '../../infrastructure/db.js';
import { normalizeCategory } from './category-map.js';

export {
  createSkillBundle,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getBundleByToken,
  getCreatorBundleConfig,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listCreatorSharedSkills,
  listMarketBundles,
  listMarketSkills,
  listUserBundles,
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

export const MAX_USER_SKILLS = 30;
export const MAX_SKILL_BUNDLE_FILES = 30;
export const MAX_SKILL_BUNDLE_FILE_LENGTH = 100_000;

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
