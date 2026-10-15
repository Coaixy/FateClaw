/**
 * 技能 HTTP 场景服务层。
 *
 * 当前先作为技能域统一门面，集中承接数据库与系统排盘注册表访问，
 * 后续再继续把 route 中的验证与流程编排下沉进来。
 */

import crypto from 'crypto';

import {
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
  MAX_USER_SKILLS,
} from '@fateclaw/contracts/skills';
import {
  getSkillBundleLimitsPolicy,
  getUserSkillLimitPolicy,
} from '../system/system-config.js';

import {
  createSkillBundle,
  createSkillAccessInvite,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getBundleByToken,
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listMarketBundles,
  listMarketSkills,
  listSkillCommentsForAdmin,
  listSkillAccessInvites,
  listUserBundles,
  publishSkillBundle,
  publishUserCustomSkill,
  redeemSkillAccessInvite,
  reviewSkillCommentForAdmin,
  revokeSkillAccessInvite,
  setSkillCommentPinnedForAdmin,
  shareSkillBundle,
  shareUserCustomSkill,
  subscribeToBundle,
  subscribeToSkill,
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
} from '../../infrastructure/db.js';
import { normalizeCategory } from './category-map.js';
export { SkillRevisionConflictError } from './skill-errors.js';

export {
  createSkillBundle,
  createSkillAccessInvite,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getBundleByToken,
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listMarketBundles,
  listMarketSkills,
  listSkillCommentsForAdmin,
  listSkillAccessInvites,
  listUserBundles,
  normalizeCategory,
  publishSkillBundle,
  publishUserCustomSkill,
  redeemSkillAccessInvite,
  reviewSkillCommentForAdmin,
  revokeSkillAccessInvite,
  setSkillCommentPinnedForAdmin,
  shareSkillBundle,
  shareUserCustomSkill,
  subscribeToBundle,
  subscribeToSkill,
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
};

export {
  getSkillBundleLimitsPolicy,
  getUserSkillLimitPolicy,
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
  MAX_USER_SKILLS,
};

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
