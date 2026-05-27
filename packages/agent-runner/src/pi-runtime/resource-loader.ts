import {
  createExtensionRuntime,
  createSyntheticSourceInfo,
  loadSkillsFromDir,
  type LoadExtensionsResult,
  type ResourceDiagnostic,
  type ResourceLoader,
  type Skill,
} from '@earendil-works/pi-coding-agent';

import type { AgentRuntimeDeps } from '../deps.js';
import { SKILLS_DIR } from '../paths.js';
import { traceEvent } from '../trace.js';
import type { RequestScope } from '../request-scope.js';
import type { ContainerInput } from '../types.js';
import { getTextSkillBundleSkillFile } from '../text-skill-bundle.js';
import { PI_DETERMINISTIC_SCRIPT_TOOLS } from './deterministic-tool-catalog.js';
import { PI_INTERPRET_TOOL_NAME } from './interpret-tool-catalog.js';

export interface CreatePiResourceLoaderOptions {
  deps: AgentRuntimeDeps;
  userId?: string;
  requestScope: RequestScope;
  containerInput: ContainerInput;
  skillsDir?: string;
}

function createSkill(args: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): Skill {
  return {
    name: args.name,
    description: args.description,
    filePath: args.filePath,
    baseDir: args.baseDir,
    sourceInfo: createSyntheticSourceInfo(args.filePath, {
      source: args.source,
      baseDir: args.baseDir,
    }),
    disableModelInvocation: args.disableModelInvocation ?? false,
  };
}

interface RequestKnowledgeEntry {
  name: string;
  description: string;
  category: string;
  source: string;
}

const PI_OFFICIAL_SKILL_ALIASES = [
  ...PI_DETERMINISTIC_SCRIPT_TOOLS.map((tool) => ({
    skillName: tool.skillName,
    aliases: [tool.skillName, tool.displayName, tool.toolName],
  })),
  {
    skillName: 'xuanxue-jiedu',
    aliases: ['xuanxue-jiedu', '玄学解读', '通枢解读', PI_INTERPRET_TOOL_NAME],
  },
];

function resolveEnabledPiOfficialSkillNames(
  enabledSkillNames: readonly string[],
): Set<string> {
  const enabled = new Set(enabledSkillNames);
  const resolved = new Set<string>();

  for (const item of PI_OFFICIAL_SKILL_ALIASES) {
    if (item.aliases.some((alias) => enabled.has(alias))) {
      resolved.add(item.skillName);
    }
  }

  for (const name of enabledSkillNames) {
    resolved.add(name);
  }

  return resolved;
}

async function loadRequestScopedSkills(
  options: CreatePiResourceLoaderOptions,
): Promise<{
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
  privateKnowledgeEntries: RequestKnowledgeEntry[];
}> {
  const skillsDir = options.skillsDir ?? SKILLS_DIR;
  const officialSkillNames = await options.deps.skillCatalog.listEnabledSkillNames(
    options.userId,
  );
  const enabledOfficialSkills =
    resolveEnabledPiOfficialSkillNames(officialSkillNames);
  const loadedOfficialSkills = loadSkillsFromDir({
    dir: skillsDir,
    source: 'fateclaw-official',
  });
  const officialSkills = loadedOfficialSkills.skills.filter((skill) =>
    enabledOfficialSkills.has(skill.name),
  );

  const effectivePrivateKnowledge = options.userId
    ? await options.deps.skillCatalog.listEffectiveUserSkills(options.userId)
    : [];
  const privateKnowledgeEntries = effectivePrivateKnowledge
    .filter((skill) => getTextSkillBundleSkillFile(skill.bundle_uri))
    .map((skill) => ({
      name: skill.dir,
      description: skill.description || skill.trigger || skill.name,
      category: skill.category || '通用',
      source: skill.source,
    }));
  const privateKnowledgeSkills = effectivePrivateKnowledge.flatMap((skill) => {
    const bundle = getTextSkillBundleSkillFile(skill.bundle_uri);
    if (!bundle) return [];
    return [createSkill({
      name: skill.dir,
      description:
        [
          skill.description || skill.trigger || skill.name,
          `category=${skill.category || '通用'}`,
          `source=${skill.source}`,
          'request-scoped Text Skill Bundle，可按需读取 SKILL.md/index.md/docs/examples/notes。',
        ].join(' | '),
      filePath: bundle.filePath,
      baseDir: bundle.baseDir,
      source: 'fateclaw-request-knowledge',
      disableModelInvocation: false,
    })];
  });

  traceEvent(
    {
      type: 'pi_resource_loader_prepared',
      officialSkillCount: officialSkills.length,
      privateKnowledgeSkillCount: privateKnowledgeSkills.length,
      isolation: 'request_scoped',
    },
    options.requestScope,
  );

  return {
    skills: [...officialSkills, ...privateKnowledgeSkills],
    diagnostics: loadedOfficialSkills.diagnostics,
    privateKnowledgeEntries,
  };
}

export function createEmptyExtensionsResult(): LoadExtensionsResult {
  return {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
}

export async function createPiResourceLoader(
  options: CreatePiResourceLoaderOptions,
): Promise<ResourceLoader> {
  const { skills, diagnostics, privateKnowledgeEntries } =
    await loadRequestScopedSkills(options);
  const extensions = createEmptyExtensionsResult();
  const systemPrompt = buildPiSystemPrompt(options.containerInput);
  const appendSystemPrompt = buildAppendSystemPrompt(privateKnowledgeEntries);

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills, diagnostics }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => appendSystemPrompt,
    extendResources: () => {
      // 私有知识库只允许 request-scoped loader 注入，忽略运行时额外发现路径。
    },
    reload: async () => {
      // 当前 loader 是请求级不可变快照，避免跨用户热加载污染。
    },
  };
}

function buildAppendSystemPrompt(
  privateKnowledgeEntries: RequestKnowledgeEntry[],
): string[] {
  if (privateKnowledgeEntries.length === 0) return [];
  return [
    [
      '本轮可见的用户私有知识库入口如下。',
      '这些入口不是本地 Pi Skill，不能直接 /skill 调用；如需正文，必须通过本轮授权知识库工具按需读取。',
      ...privateKnowledgeEntries.map((entry) =>
        [
          `- ${entry.name}`,
          `category=${entry.category}`,
          `source=${entry.source}`,
          `description=${entry.description}`,
        ].join(' | '),
      ),
    ].join('\n'),
  ];
}

function buildPiSystemPrompt(containerInput: ContainerInput): string {
  const persona = containerInput.personaPrompt?.trim();
  return [
    persona ? `${persona}\n\n---` : '',
    '你是 FateClaw 的 Pi-backed Agent Runtime。',
    '你必须通过可用工具完成需要确定性数据、排盘、知识库读取、记忆或时间换算的任务。',
    '排盘、解读、知识库和记忆都只允许调用本次 session 暴露的 custom tools；不要声称访问未列出的能力。',
    '用户私有知识库只通过本次请求的授权工具读取，不能假设存在全局本地 Skill。',
    '完成用户请求后，调用 final_reply 返回最终答复；不要在普通 assistant 文本中结束任务。',
    '玄学专业解读必须先调用 interpret_xuanxue 准备权威盘面和知识库材料，再基于工具返回内容作答。',
    '如果缺少关键参数，调用 final_reply 明确说明需要补充哪些信息。',
  ]
    .filter(Boolean)
    .join('\n\n');
}
