/**
 * Agent → Skill 脚本的环境变量白名单构建。
 *
 * Skill 脚本只能看到此处列出的变量，看不到 AI 凭据和宿主机密钥。
 * 新增 skill 可用的 env 只需改此文件。
 */

import { getContext } from './context.js';
import { pickSystemEnv } from './process-env.js';

/**
 * 构建传给 skill 脚本的 env。
 * 显式白名单，不 spread process.env。
 */
export function buildSkillEnv(
  _skillName: string,
  skillDir: string,
): Record<string, string> {
  const ctx = getContext();

  const env: Record<string, string | undefined> = {
    ...pickSystemEnv(),
    // 身份上下文
    FATECLAW_ACCOUNT_ID: ctx.accountId,
    FATECLAW_USER_ID: ctx.userId || undefined,
    FATECLAW_TIMEZONE: ctx.timezone,

    // Skill 元数据
    SKILL_NAME: _skillName,
    SKILL_DIR: skillDir,
    SKILL_API_BASE: ctx.skillApiBase,

    // 系统必需
    TZ: ctx.timezone,
  };

  // 过滤 undefined 值
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') {
      result[key] = value;
    }
  }
  return result;
}
