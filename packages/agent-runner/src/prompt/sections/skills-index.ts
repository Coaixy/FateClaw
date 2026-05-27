import type { AgentRuntimeDeps } from '../../deps.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { loadSkillMetadataList, loadEnabledSkillNames } from '../skills.js';
import { formatParamSignature } from '../../skill-param-validator.js';

interface SkillsIndexOptions {
  maxUserSkills?: number;
  deps?: AgentRuntimeDeps;
}

function buildOfficialSkillSummaryLine(
  skill: Awaited<ReturnType<typeof loadSkillMetadataList>>[number],
): string {
  const parts = [
    `${skill.name} (skill_name: \`${skill.dir}\`)`,
    skill.description,
  ];
  if (skill.entry?.type === 'tool') {
    parts.push(`入口=${skill.entry.tool}`);
  } else if (skill.entry?.type === 'script') {
    parts.push(`入口=${skill.entry.file}`);
  }
  if (skill.trigger) {
    parts.push(`触发=${skill.trigger}`);
  }
  if (skill.parameters?.conditionalRequired?.length) {
    parts.push(
      `条件参数=${skill.parameters.conditionalRequired
        .map(
          (rule) =>
            `${rule.when.field}=${JSON.stringify(rule.when.equals)}=>${rule.required.join('/')}`,
        )
        .join(';')}`,
    );
  }
  if (skill.parameters?.atLeastOneOf?.length) {
    parts.push(
      `至少一项=${skill.parameters.atLeastOneOf
        .map((fields) => fields.join('/'))
        .join(';')}`,
    );
  }
  if (skill.parameters?.allOrNoneOf?.length) {
    parts.push(
      `成组参数=${skill.parameters.allOrNoneOf
        .map((fields) => fields.join('/'))
        .join(';')}`,
    );
  }
  return `- ${parts.filter(Boolean).join(' | ')}`;
}

function buildUserSkillSummaryLine(
  skill: Awaited<ReturnType<typeof loadSkillMetadataList>>[number],
): string {
  const modeLabel = skill.usageMode === 'force_injected' ? '强规则' : '参考';
  const parts = [
    `${skill.name} (skill_name: \`${skill.dir}\`)`,
    skill.description,
    `模式=${modeLabel}`,
  ];
  if (skill.category) {
    parts.push(`类别=${skill.category}`);
  }
  if (skill.trigger) {
    parts.push(`触发=${skill.trigger}`);
  }
  return `- ${parts.filter(Boolean).join(' | ')}`;
}

/**
 * 可用 Skills 索引：当前只展示官方 capability。
 * 用户规则 skill 由 interpret_xuanxue 内部自动拉取，不在这里展开。
 */
export async function buildSkillsIndexSection(
  accountId: string,
  options: SkillsIndexOptions = {},
): Promise<string[]> {
  const deps = options.deps ?? getDefaultAgentRuntimeDeps();
  const allSkills = await loadSkillMetadataList(undefined, accountId, deps);
  const enabledList = await loadEnabledSkillNames(deps);

  // 官方 skill 按 DB 中的 skill_global_config 过滤；用户 skill 已在 DB 查询中预过滤
  const officialSkills = allSkills.filter(
    (s) => s.type !== 'user' && enabledList.includes(s.name),
  );

  if (officialSkills.length === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push('', '## 当前可用官方 Skill');
  lines.push(
    '以下是当前账号可用的官方能力。实际可执行入口必须以本轮 tools schema 为准，不要自行猜测脚本入口或参数格式。',
  );
  for (const skill of officialSkills) {
    lines.push(buildOfficialSkillSummaryLine(skill));
    if (skill.parameters) {
      lines.push(`  参数签名: ${formatParamSignature(skill.parameters)}`);
    }
  }

  return lines;
}
