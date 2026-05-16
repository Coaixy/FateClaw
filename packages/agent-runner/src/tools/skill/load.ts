/**
 * load_skill 工具 — 按目录名加载 skill 的完整说明。
 *
 * 在执行 skill 之前，先通过此工具获取 SKILL.md 的详细指引，
 * 了解 skill 的唯一公开入口与参数规则。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import {
  loadSkillMetadataList,
  loadSkillContent,
  loadEnabledSkillNames,
} from '../../prompt/skills.js';
import { formatParamSignature } from '../../skill-param-validator.js';
import { getContext } from '../../context.js';
import { log } from '../../io.js';
import { markSkillLoaded } from '../../request-scope.js';
import { SKILLS_DIR } from '../../paths.js';
import type {
  SkillExamplePayload,
  SkillRuntimeGuidancePayload,
  SkillRuntimePayload,
} from '../../prompt/types.js';
import { createToolErrorResult } from './tool-error.js';

const SKILL_RUNTIME_PROTOCOL_VERSION = 1 as const;

function buildExampleValue(key: string, prop: { type?: unknown; default?: unknown; enum?: unknown[]; items?: { enum?: unknown[] } }): unknown {
  if (prop.default !== undefined) return prop.default;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[0];
  }

  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      if (prop.items?.enum && prop.items.enum.length > 0) {
        return [prop.items.enum[0]];
      }
      return [];
    case 'object':
      return {};
    case 'string':
    default:
      return `<${key}>`;
  }
}

function buildExamplePayload(
  schema?: Awaited<ReturnType<typeof loadSkillMetadataList>>[number]['parameters'],
): Record<string, unknown> {
  if (!schema) return {};

  const payload: Record<string, unknown> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (required.has(key) || prop.default !== undefined) {
      payload[key] = buildExampleValue(key, prop);
    }
  }
  return payload;
}

function buildExamplePayloads(
  schema?: Awaited<ReturnType<typeof loadSkillMetadataList>>[number]['parameters'],
): SkillExamplePayload[] {
  if (!schema) return [];
  if (schema.examples && schema.examples.length > 0) {
    return schema.examples;
  }

  const generated = buildExamplePayload(schema);
  return Object.keys(generated).length > 0
    ? [{ name: '默认示例', value: generated }]
    : [];
}

function buildRuleLines(
  schema?: Awaited<ReturnType<typeof loadSkillMetadataList>>[number]['parameters'],
): string[] {
  if (!schema) return [];

  const lines: string[] = [];
  for (const requirement of schema.conditionalRequired ?? []) {
    lines.push(
      `- ${requirement.description || `当 ${requirement.when.field}=${JSON.stringify(requirement.when.equals)} 时，必须提供 ${requirement.required.join('、')}`}`,
    );
  }
  for (const fields of schema.atLeastOneOf ?? []) {
    lines.push(`- ${fields.join('、')} 至少提供一个`);
  }
  for (const fields of schema.allOrNoneOf ?? []) {
    lines.push(`- ${fields.join('、')} 必须同时提供，或同时不提供`);
  }
  return lines;
}

function buildOfficialSkillRuntimeHeader(
  skillName: string,
  skill: Awaited<ReturnType<typeof loadSkillMetadataList>>[number],
): string {
  const payload: SkillRuntimePayload = {
    protocol_version: SKILL_RUNTIME_PROTOCOL_VERSION,
    skill_name: skillName,
    display_name: skill.name,
    requires_load: skill.requiresLoad !== false,
    manifest_source: skill.manifestSource || 'skill.json',
    entry: skill.entry,
    parameter_signature: skill.parameters
      ? formatParamSignature(skill.parameters)
      : undefined,
    parameters_schema: skill.parameters,
  };

  return [
    `<skill-runtime skill="${skillName}">`,
    JSON.stringify(payload, null, 2),
    '</skill-runtime>',
  ].join('\n');
}

function buildRunSkillScriptExample(
  skillName: string,
  script: string,
  schema?: Awaited<ReturnType<typeof loadSkillMetadataList>>[number]['parameters'],
): string[] {
  const examples = buildExamplePayloads(schema);
  if (examples.length === 0) {
    return [
      '```text',
      'run_skill_script({',
      `  skill_name: "${skillName}",`,
      `  script: "${script}",`,
      '  stdin: JSON.stringify({})',
      '})',
      '```',
    ];
  }

  return examples.flatMap((example) => {
    const lines: string[] = [];
    if (example.name || example.description) {
      lines.push(
        `示例${example.name ? `：${example.name}` : ''}${example.description ? ` - ${example.description}` : ''}`,
      );
    }
    lines.push(
      '```text',
      'run_skill_script({',
      `  skill_name: "${skillName}",`,
      `  script: "${script}",`,
      `  stdin: JSON.stringify(${JSON.stringify(example.value, null, 2)})`,
      '})',
      '```',
    );
    return lines;
  });
}

function buildCompositeToolExample(
  toolName: string,
  schema?: Awaited<ReturnType<typeof loadSkillMetadataList>>[number]['parameters'],
): string {
  const payload =
    buildExamplePayloads(schema)[0]?.value ?? buildExamplePayload(schema);
  return [
    '```text',
    `${toolName}(${JSON.stringify(payload, null, 2)})`,
    '```',
  ].join('\n');
}

function buildOfficialSkillRuntimeGuidance(
  skillName: string,
  skill: Awaited<ReturnType<typeof loadSkillMetadataList>>[number],
): string {
  const notes: string[] = [];
  const lines: string[] = [
    `<skill-runtime-guidance skill="${skillName}">`,
  ];

  let payload: SkillRuntimeGuidancePayload;

  if (skill.entry?.type === 'tool') {
    notes.push(
      '不要直接调用 run_skill_script。',
      `通过工具入口 \`${skill.entry.tool}\` 执行。`,
    );
    payload = {
      protocol_version: SKILL_RUNTIME_PROTOCOL_VERSION,
      skill_name: skillName,
      recommended_entry: {
        type: 'tool',
        tool: skill.entry.tool,
        fallbackScript: skill.entry.fallbackScript,
      },
      notes,
    };
  } else if (skill.entry?.type === 'script') {
    notes.push(`唯一公开脚本入口为 \`${skill.entry.file}\`。`);
    notes.push(
      '同一个 agent loop 的同一轮里，同一个 skill/script 在成功执行后默认不要再次调用；如需重新起卦/重排，应在后续轮次再决定。',
    );
    payload = {
      protocol_version: SKILL_RUNTIME_PROTOCOL_VERSION,
      skill_name: skillName,
      recommended_entry: {
        type: 'script',
        file: skill.entry.file,
      },
      notes,
    };
  } else {
    payload = {
      protocol_version: SKILL_RUNTIME_PROTOCOL_VERSION,
      skill_name: skillName,
      recommended_entry: {
        type: 'knowledge_only',
      },
      notes,
    };
  }

  lines.push(
    JSON.stringify(payload, null, 2),
    '---',
    '推荐执行方式：',
  );

  const ruleLines = buildRuleLines(skill.parameters);
  if (ruleLines.length > 0) {
    lines.push('参数规则：', ...ruleLines);
  }

  if (skill.entry?.type === 'tool') {
    lines.push('1. 不要直接调用 run_skill_script。');
    lines.push(`2. 通过工具入口 \`${skill.entry.tool}\` 执行。`);
    lines.push('推荐调用示例：');
    lines.push(buildCompositeToolExample(skill.entry.tool, skill.parameters));
    if (skill.entry.fallbackScript) {
      lines.push(`内部降级脚本：${skill.entry.fallbackScript}`);
    }
  } else {
    if (skill.entry?.type === 'script') {
      lines.push(`1. 唯一公开脚本入口为 \`${skill.entry.file}\`。`);
      lines.push('默认调用示例：');
      lines.push(
        ...buildRunSkillScriptExample(
          skillName,
          skill.entry.file,
          skill.parameters,
        ),
      );
    }
  }

  lines.push('</skill-runtime-guidance>');
  return lines.join('\n');
}

export const loadSkill: ToolSpec = {
  executionMode: 'parallel',
  definition: {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        '按目录名加载一个 skill 的完整说明。当用户的请求匹配 system prompt 中列出的某个 skill 时，先调用此工具获取详细指引再执行。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description:
              'skill 目录名（即 system prompt 中 skill_name 字段的值，如 "qimen-paipan"）',
          },
        },
        required: ['skill_name'],
      },
    },
  },

  prompt: `## load_skill — 加载技能说明

在执行任何 skill 脚本之前，必须先通过此工具加载该 skill 的完整说明文档（SKILL.md）。
官方 skill 的返回会包含结构化的 \`<skill-runtime>\` 和 \`<skill-runtime-guidance>\` 头部，二者都带有稳定的 \`protocol_version\` 字段。应优先按这些结构头部理解运行方式，再结合后面的 SKILL.md 细节。

### 使用流程
1. 在 system prompt 的 skill 列表中找到匹配用户请求的 skill。
2. 调用 load_skill 传入 skill_name（目录名，不是显示名称）。
3. 阅读返回的 SKILL.md 内容，了解唯一公开入口、参数格式和调用规范。
4. 按照 SKILL.md 中的指引执行该 skill。

### 参数说明
- **skill_name**：skill 的目录名，即 system prompt 中列出的 skill_name 字段值，须与 system prompt 完全一致。不是 skill 的中文显示名称。例如应传入 "qimen-paipan" 而非 "奇门遁甲"。

### 注意事项
- skill_name 不能包含路径分隔符（/ 或 \\），这是安全限制。
- 只有已启用的 skill 才能加载，未启用的会返回错误提示。
- 如果 SKILL.md 涉及时间戳参数，返回内容会自动追加 convert_time 使用提醒。
- 不要跳过 load_skill 直接执行 skill，SKILL.md 中包含关键的入口和参数规范。`,

  execute: async (args: Record<string, unknown>, options) => {
    const skillName = args.skill_name as string;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();

    if (skillName.includes('/') || skillName.includes('\\')) {
      return createToolErrorResult({
        code: 'SKILL.INVALID_NAME',
        kind: 'validation',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: 'skill 名称不能包含路径分隔符。',
        details: { skillName },
      });
    }

    const accountId = getContext().accountId;
    const skillsDir = options?.skillsDirOverride ?? SKILLS_DIR;
    const skills = await loadSkillMetadataList(skillsDir, accountId, deps);
    const matched = skills.find((s) => s.dir === skillName);
    if (!matched) {
      const available = skills.map((s) => s.dir).join(', ') || '无';
      return createToolErrorResult({
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
      });
    }

    // 用户知识 Skill → 直接返回内联 content（附加路由元信息）
    if (matched.type === 'user' && matched.content) {
      const mode = matched.usageMode || 'reference_only';
      const cat = matched.category || '通用';
      const output = `<user-knowledge skill="${skillName}" usage_mode="${mode}" category="${cat}">\n${matched.content}\n</user-knowledge>`;
      if (options?.requestScope) {
        markSkillLoaded(options.requestScope, skillName);
      }
      log(`工具结果: load_skill name=${skillName} type=user mode=${mode} length=${output.length}`);
      return { output };
    }

    if (!(await loadEnabledSkillNames(deps)).includes(matched.name)) {
      return createToolErrorResult({
        code: 'SKILL.NOT_ENABLED',
        kind: 'availability',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: `Skill "${skillName}" 未启用，请在管理面板中开启后再使用。`,
        details: {
          skillName,
          displayName: matched.name,
        },
      });
    }

    const content = loadSkillContent(skillName, skillsDir, deps);
    if (!content) {
      return createToolErrorResult({
        code: 'SKILL.CONTENT_MISSING',
        kind: 'internal',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: `Skill "${skillName}" 缺少 SKILL.md 内容文件。`,
        details: { skillName },
      });
    }

    // 当 SKILL.md 涉及时间戳参数时，自动追加 convert_time 使用提醒
    const TIMESTAMP_HINT =
      '\n\n> ⚠️ 本 skill 使用 Unix 时间戳参数。当用户提供了日期时间文字时，必须先调用 convert_time 工具获取准确时间戳，禁止自行计算。';
    const needsTimestampHint = /unix\s*时间戳|时间戳（秒）/i.test(content);
    const runtimeHeader = buildOfficialSkillRuntimeHeader(skillName, matched);
    const runtimeGuidance = buildOfficialSkillRuntimeGuidance(skillName, matched);
    const markdownWithHint = needsTimestampHint
      ? content + TIMESTAMP_HINT
      : content;
    const output = `${runtimeHeader}\n\n${runtimeGuidance}\n\n${markdownWithHint}`;

    if (options?.requestScope) {
      markSkillLoaded(options.requestScope, skillName);
    }
    log(`工具结果: load_skill name=${skillName} length=${output.length}`);
    return { output };
  },
};
