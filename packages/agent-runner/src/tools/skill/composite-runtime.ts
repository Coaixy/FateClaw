import { findOfficialCompositeSkillByTool } from '../../prompt/skills.js';
import type { SkillMetadata } from '../../prompt/types.js';
import { hasLoadedSkill } from '../../request-scope.js';
import type { ToolExecutionOptions, ToolResult } from '../../types.js';
import { executeRunSkillScript } from './run-script.js';
import { createToolErrorResult } from './tool-error.js';

export interface CompositeSkillReadyResult {
  ok: true;
  skill: SkillMetadata;
}

export interface CompositeSkillErrorResult {
  ok: false;
  result: ToolResult;
}

export type CompositeSkillGuardResult =
  | CompositeSkillReadyResult
  | CompositeSkillErrorResult;

export function resolveCompositeSkillDirByTool(
  toolName: string,
  skillsDir?: string,
): string | undefined {
  return findOfficialCompositeSkillByTool(toolName, skillsDir)?.dir;
}

export function ensureCompositeSkillReady(
  toolName: string,
  options?: ToolExecutionOptions,
): CompositeSkillGuardResult {
  const compositeSkill = findOfficialCompositeSkillByTool(
    toolName,
    options?.skillsDirOverride,
    options?.runtimeDeps,
  );
  if (!compositeSkill) {
    return {
      ok: false,
      result: createToolErrorResult({
        code: 'SKILL.COMPOSITE_NOT_FOUND',
        kind: 'internal',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: `未找到与 ${toolName} 绑定的 composite skill 配置。`,
        details: { toolName },
      }),
    };
  }

  if (compositeSkill.requiresLoad !== false) {
    if (!options?.requestScope) {
      return {
        ok: false,
        result: createToolErrorResult({
          code: 'SKILL.REQUEST_SCOPE_MISSING',
          kind: 'internal',
          retryable: false,
          userSafe: false,
          nextAction: 'stop',
          internalMessage:
            '运行时缺少 requestScope，无法校验 composite skill 的 load_skill 前置条件。',
          details: {
            toolName,
            skillName: compositeSkill.dir,
          },
        }),
      };
    }

    if (!hasLoadedSkill(options.requestScope, compositeSkill.dir)) {
      return {
        ok: false,
        result: createToolErrorResult({
          code: 'SKILL.LOAD_REQUIRED',
          kind: 'dependency',
          retryable: true,
          userSafe: false,
          nextAction: 'load_skill',
          internalMessage: `调用 ${toolName} 前必须先执行 load_skill("${compositeSkill.dir}")。`,
          details: {
            toolName,
            skillName: compositeSkill.dir,
            requiredTool: 'load_skill',
          },
        }),
      };
    }
  }

  return { ok: true, skill: compositeSkill };
}

export async function executeCompositeSkillFallback(
  skill: SkillMetadata,
  stdin: string,
  options?: ToolExecutionOptions,
): Promise<ToolResult> {
  const fallbackScript =
    skill.entry?.type === 'tool' ? skill.entry.fallbackScript || 'ask.js' : 'ask.js';
  return executeRunSkillScript(
    {
      skill_name: skill.dir,
      script: fallbackScript,
      stdin,
    },
    {
      signal: options?.signal,
      requestScope: options?.requestScope,
      loopIteration: options?.loopIteration,
      loopRunId: options?.loopRunId,
      skillsDir: options?.skillsDirOverride,
      bypassLoadRequirement: true,
      runtimeDeps: options?.runtimeDeps,
    },
  );
}
