import type { AgentRuntimeDeps } from './deps.js';
import { getDefaultAgentRuntimeDeps } from './deps.js';
import { SKILLS_DIR } from './paths.js';
import { getContext } from './context.js';
import { log } from './io.js';
import type { SkillMetadata } from './skill-metadata-types.js';

export function loadOfficialSkillMetadataList(
  skillsDir: string = SKILLS_DIR,
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): SkillMetadata[] {
  return deps.skillCatalog.listOfficialSkillMetadata(skillsDir);
}

export function findOfficialCompositeSkillByTool(
  toolName: string,
  skillsDir: string = SKILLS_DIR,
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): SkillMetadata | null {
  const officialSkills = loadOfficialSkillMetadataList(skillsDir, deps);
  return (
    officialSkills.find(
      (skill) => skill.entry?.type === 'tool' && skill.entry.tool === toolName,
    ) || null
  );
}

/** 扫描 Pi Skill 目录，只读取 SKILL.md frontmatter 轻量元数据。 */
export async function loadSkillMetadataList(
  skillsDir: string = SKILLS_DIR,
  accountId?: string,
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): Promise<SkillMetadata[]> {
  const officialSkills = loadOfficialSkillMetadataList(skillsDir, deps);

  // 合并用户自定义知识 Skill（从 DB 查询）
  if (accountId) {
    const userSkills = await loadUserSkillsList(deps);
    return [...officialSkills, ...userSkills];
  }
  return officialSkills;
}

/**
 * 按 skill 目录名加载完整 SKILL.md 内容。
 */
export function loadSkillContent(
  skillDir: string,
  skillsDir: string = SKILLS_DIR,
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): string | null {
  return deps.skillCatalog.loadOfficialSkillContent(skillDir, skillsDir);
}

/**
 * 从数据库查询当前用户可用的官方 Skill 名称列表。
 * 自动从 context 取 userId，排除用户显式禁用的 skill。
 * 返回 string[]（空数组 = 全部禁用）。
 */
export async function loadEnabledSkillNames(
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): Promise<string[]> {
  try {
    const userId = getContext().userId;
    return await deps.skillCatalog.listEnabledSkillNames(userId || undefined);
  } catch (err) {
    log(
      `loadEnabledSkillNames failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * 从数据库查询用户的有效自定义知识 Skill（自有 + 订阅），返回 SkillMetadata 列表。
 * 使用 context 中的 userId 查询。
 */
export async function loadUserSkillsList(
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): Promise<SkillMetadata[]> {
  const userId = getContext().userId;
  if (!userId) return [];

  try {
    const skills = await deps.skillCatalog.listEffectiveUserSkills(userId);
    return skills.map((item) => ({
      dir: item.dir,
      name: item.name,
      description: item.description || '',
      trigger: item.trigger || '',
      type: 'user' as const,
      manifestSource: 'user-skill' as const,
      requiresLoad: false,
      source: (item.source as 'self' | 'subscribed') || 'self',
      category: item.category || '通用',
      usageMode: item.usage_mode ?? 'reference_only',
    }));
  } catch (err) {
    log(
      `loadUserSkillsList failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
