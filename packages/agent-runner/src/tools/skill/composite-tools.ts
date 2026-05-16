import { formatParamSignature } from '../../skill-param-validator.js';
import { loadOfficialSkillMetadataList } from '../../prompt/skills.js';
import type { SkillMetadata } from '../../prompt/types.js';
import { log } from '../../io.js';
import type { ToolExecutionOptions, ToolResult, ToolSpec } from '../../types.js';
import {
  executeCompositeSkillFallback,
  ensureCompositeSkillReady,
} from './composite-runtime.js';
import {
  executeInterpretXuanxue,
  interpretXuanxuePrompt,
} from './interpret-xuanxue.js';

type CompositeToolHandler = (
  args: Record<string, unknown>,
  options?: ToolExecutionOptions,
) => Promise<ToolResult>;

export interface CompositeHandlerRegistration {
  execute: CompositeToolHandler;
  prompt?: string;
}

export interface CompositeToolDiagnostic {
  skillDir: string;
  toolName: string;
  mode: 'handler-backed' | 'fallback-only';
  fallbackScript?: string;
}

const compositeHandlerRegistry = new Map<string, CompositeHandlerRegistration>();

export function registerCompositeHandler(
  toolName: string,
  registration: CompositeHandlerRegistration,
): void {
  if (compositeHandlerRegistry.has(toolName)) {
    throw new Error(`重复注册 composite handler: ${toolName}`);
  }
  compositeHandlerRegistry.set(toolName, registration);
}

registerCompositeHandler('interpret_xuanxue', {
  execute: executeInterpretXuanxue,
  prompt: interpretXuanxuePrompt,
});

function buildGenericCompositePrompt(skillName: string): string {
  return [
    `## ${skillName} — Composite Skill`,
    '',
    '这是一个 composite skill 的工具入口。',
    `调用前必须先执行 \`load_skill(skill_name="${skillName}")\`，不要跳过。`,
    '如果存在自定义执行器，运行时会优先走自定义执行器；否则自动降级到 skill manifest 声明的 fallback 脚本。',
  ].join('\n');
}

function validateCompositeSkills(
  skills: SkillMetadata[],
  handlerRegistry: ReadonlyMap<string, CompositeHandlerRegistration>,
): Map<string, SkillMetadata> {
  const toolToSkill = new Map<string, SkillMetadata>();

  for (const skill of skills) {
    if (skill.entry?.type !== 'tool') continue;
    if (!skill.entry.tool) {
      throw new Error(
        `tool-entry skill "${skill.dir}" 缺少 entry.tool 配置`,
      );
    }
    const existing = toolToSkill.get(skill.entry.tool);
    if (existing) {
      throw new Error(
        `tool entry 冲突: "${skill.entry.tool}" 同时被 "${existing.dir}" 和 "${skill.dir}" 声明`,
      );
    }
    toolToSkill.set(skill.entry.tool, skill);
  }

  for (const registeredTool of handlerRegistry.keys()) {
    if (!toolToSkill.has(registeredTool)) {
      throw new Error(
        `composite handler "${registeredTool}" 未找到对应的 composite skill manifest`,
      );
    }
  }

  return toolToSkill;
}

export function buildCompositeToolSpecsForSkills(
  skills: SkillMetadata[],
  handlerRegistry: ReadonlyMap<string, CompositeHandlerRegistration> = compositeHandlerRegistry,
): {
  specs: ToolSpec[];
  diagnostics: CompositeToolDiagnostic[];
} {
  const compositeSkills = skills.filter((skill) => skill.entry?.type === 'tool');
  const toolToSkill = validateCompositeSkills(compositeSkills, handlerRegistry);
  const diagnostics: CompositeToolDiagnostic[] = [];

  const specs = Array.from(toolToSkill.entries()).map(([toolName, skill]) => {
      const registration = handlerRegistry.get(toolName);

      const execute: CompositeToolHandler =
        registration?.execute ??
        (async (args, options) => {
          const guard = ensureCompositeSkillReady(toolName, options);
          if (!guard.ok) return guard.result;
          return executeCompositeSkillFallback(
            guard.skill,
            JSON.stringify(args),
            options,
          );
        });

      const parameters = skill.parameters ?? {
        type: 'object' as const,
        properties: {},
        required: [],
      };
      const prompt =
        registration?.prompt ??
        [
          buildGenericCompositePrompt(skill.dir),
          skill.parameters
            ? `参数: ${formatParamSignature(skill.parameters)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n');

      diagnostics.push({
        skillDir: skill.dir,
        toolName,
        mode: registration ? 'handler-backed' : 'fallback-only',
        fallbackScript:
          skill.entry?.type === 'tool' ? skill.entry.fallbackScript : undefined,
      });

      return {
        executionMode: 'serial' as const,
        definition: {
          type: 'function' as const,
          function: {
            name: toolName,
            description: skill.description || `${skill.name} composite tool`,
            parameters,
          },
        },
        prompt,
        execute,
      };
    });

  return { specs, diagnostics };
}

export function buildCompositeToolSpecsForDir(
  skillsDir: string,
  handlerRegistry: ReadonlyMap<string, CompositeHandlerRegistration> = compositeHandlerRegistry,
): {
  specs: ToolSpec[];
  diagnostics: CompositeToolDiagnostic[];
} {
  return buildCompositeToolSpecsForSkills(
    loadOfficialSkillMetadataList(skillsDir),
    handlerRegistry,
  );
}

export function logCompositeToolDiagnostics(
  diagnostics: CompositeToolDiagnostic[],
): void {
  if (diagnostics.length === 0) {
    log('Composite tools 已加载: 0');
    return;
  }
  const summary = diagnostics
    .map((item) => {
      const fallback = item.fallbackScript
        ? ` fallback=${item.fallbackScript}`
        : '';
      return `${item.toolName}<-${item.skillDir} [${item.mode}]${fallback}`;
    })
    .join(', ');
  log(`Composite tools 已加载: ${diagnostics.length} | ${summary}`);
}
