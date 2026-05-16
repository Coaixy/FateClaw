import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';
import { SKILLS_DIR } from '../../paths.js';
import { loadSkillMetadataList } from '../../prompt/skills.js';
import type {
  SkillEntry,
  SkillMetadata,
  SkillParametersSchema,
} from '../../prompt/types.js';
import { hasLoadedSkill } from '../../request-scope.js';
import type { ToolExecutionOptions, ToolResult } from '../../types.js';
import { createToolErrorResult } from './tool-error.js';

export interface ResolvedSkillAction {
  file: string;
  parameters?: SkillParametersSchema;
}

export interface ReadySkillResult {
  ok: true;
  skill: SkillMetadata;
  skillsDir: string;
}

export interface SkillErrorResult {
  ok: false;
  result: ToolResult;
}

export type SkillGuardResult = ReadySkillResult | SkillErrorResult;

export interface SkillRuntimeOptions extends ToolExecutionOptions {
  bypassLoadRequirement?: boolean;
}

function isPathSeparated(name: string): boolean {
  return name.includes('/') || name.includes('\\');
}

export async function ensureRunnableSkillReady(
  skillName: string,
  options?: SkillRuntimeOptions,
): Promise<SkillGuardResult> {
  const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();
  if (isPathSeparated(skillName)) {
    return {
      ok: false,
      result: createToolErrorResult({
        code: 'SKILL.INVALID_NAME',
        kind: 'validation',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: 'skill 名称不能包含路径分隔符。',
        details: { skillName },
      }),
    };
  }

  const accountId = getContext().accountId;
  const skillsDir = options?.skillsDirOverride ?? SKILLS_DIR;
  const skills = await loadSkillMetadataList(skillsDir, accountId, deps);
  const matched = skills.find((s) => s.dir === skillName);
  if (!matched) {
    const available = skills.map((s) => s.dir).join(', ') || '无';
    return {
      ok: false,
      result: createToolErrorResult({
        code: 'SKILL.NOT_FOUND',
        kind: 'not_found',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: `未找到 skill "${skillName}"。可用 skills: ${available}`,
        details: {
          skillName,
          availableSkills: skills.map((s) => s.dir),
        },
      }),
    };
  }

  if (matched.type === 'user') {
    return {
      ok: false,
      result: createToolErrorResult({
        code: 'SKILL.KNOWLEDGE_ONLY',
        kind: 'validation',
        retryable: false,
        userSafe: false,
        nextAction: 'load_skill',
        internalMessage: '用户知识技能不支持脚本执行，请使用 load_skill 获取知识内容。',
        details: { skillName },
      }),
    };
  }

  const enabledList = await deps.skillCatalog.listEnabledSkillNames(
    getContext().userId || undefined,
  );
  if (!enabledList.includes(matched.name)) {
    return {
      ok: false,
      result: createToolErrorResult({
        code: 'SKILL.NOT_ENABLED',
        kind: 'availability',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: `Skill "${skillName}" 未启用，请在管理面板中开启后再使用。`,
        details: { skillName, displayName: matched.name },
      }),
    };
  }

  if (matched.requiresLoad !== false && !options?.bypassLoadRequirement) {
    if (!options?.requestScope) {
      return {
        ok: false,
        result: createToolErrorResult({
          code: 'SKILL.REQUEST_SCOPE_MISSING',
          kind: 'internal',
          retryable: false,
          userSafe: false,
          nextAction: 'stop',
          internalMessage: '运行时缺少 requestScope，无法校验 load_skill 前置条件。',
          details: { skillName },
        }),
      };
    }
    if (!hasLoadedSkill(options.requestScope, skillName)) {
      return {
        ok: false,
        result: createToolErrorResult({
          code: 'SKILL.LOAD_REQUIRED',
          kind: 'dependency',
          retryable: true,
          userSafe: false,
          nextAction: 'load_skill',
          internalMessage: `调用 run_skill_script 前必须先执行 load_skill("${skillName}")。`,
          details: {
            skillName,
            requiredTool: 'load_skill',
          },
        }),
      };
    }
  }

  return {
    ok: true,
    skill: matched,
    skillsDir,
  };
}

function getScriptEntry(
  skill: SkillMetadata,
): Extract<SkillEntry, { type: 'script' }> | null {
  return skill.entry?.type === 'script' ? skill.entry : null;
}

export function resolveSkillAction(
  skill: SkillMetadata,
  requestedScript?: string,
): ResolvedSkillAction | ToolResult {
  const entry = getScriptEntry(skill);
  const toolFallback =
    skill.entry?.type === 'tool' ? skill.entry.fallbackScript : undefined;
  if (!entry) {
    if (toolFallback && requestedScript === toolFallback) {
      return {
        file: toolFallback,
        parameters: skill.parameters,
      };
    }
    return createToolErrorResult({
      code: 'SKILL.ENTRY_MISMATCH',
      kind: 'validation',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `Skill "${skill.dir}" 不是脚本入口 skill，不能通过 run_skill_script 执行。`,
      details: {
        skillName: skill.dir,
        entryType: skill.entry?.type ?? null,
      },
    });
  }

  const scriptName = requestedScript || entry.file;

  if (isPathSeparated(scriptName)) {
    return createToolErrorResult({
      code: 'SKILL.INVALID_NAME',
      kind: 'validation',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: '脚本文件名不能包含路径分隔符。',
      details: {
        skillName: skill.dir,
        script: scriptName,
      },
    });
  }
  if (scriptName !== entry.file) {
    return createToolErrorResult({
      code: 'SKILL.ENTRY_MISMATCH',
      kind: 'validation',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `Skill "${skill.dir}" 的唯一公开脚本入口是 "${entry.file}"，不能执行 "${scriptName}"。`,
      details: {
        skillName: skill.dir,
        requestedScript: scriptName,
        publicScript: entry.file,
      },
    });
  }

  return {
    file: entry.file,
    parameters: skill.parameters,
  };
}
