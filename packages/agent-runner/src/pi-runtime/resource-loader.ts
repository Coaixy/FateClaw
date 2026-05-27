import {
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type LoadExtensionsResult,
  type ResourceDiagnostic,
  type ResourceLoader,
  type Skill,
} from '@earendil-works/pi-coding-agent';

import type { AgentRuntimeDeps } from '../deps.js';
import { traceEvent } from '../trace.js';
import type { RequestScope } from '../request-scope.js';
import type { ContainerInput } from '../types.js';
import { getTextSkillBundleSkillFile } from '../text-skill-bundle.js';

export interface CreatePiResourceLoaderOptions {
  deps: AgentRuntimeDeps;
  userId?: string;
  requestScope: RequestScope;
  containerInput: ContainerInput;
  piContextPrompt?: string;
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

async function loadRequestScopedSkills(
  options: CreatePiResourceLoaderOptions,
): Promise<{
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
  privateKnowledgeEntries: RequestKnowledgeEntry[];
}> {
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
          `usageMode=${skill.usage_mode}`,
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
      privateKnowledgeSkillCount: privateKnowledgeSkills.length,
      isolation: 'request_scoped',
    },
    options.requestScope,
  );

  return {
    skills: privateKnowledgeSkills,
    diagnostics: [],
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
  const appendSystemPrompt = buildAppendSystemPrompt(
    privateKnowledgeEntries,
    options.piContextPrompt,
  );

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
  piContextPrompt?: string,
): string[] {
  const prompts: string[] = [];
  if (piContextPrompt?.trim()) {
    prompts.push(piContextPrompt);
  }
  if (privateKnowledgeEntries.length > 0) {
    prompts.push(
      [
        '本轮可见的用户私有知识库入口如下。',
        '这些入口是请求授权的 Markdown Skill 资源；如需正文，请先用 read 读取对应 SKILL.md，再按 SKILL.md/index.md 指引读取 docs/examples/notes 中的相关 Markdown 文件。',
        ...privateKnowledgeEntries.map((entry) =>
          [
            `- ${entry.name}`,
            `category=${entry.category}`,
            `source=${entry.source}`,
            `description=${entry.description}`,
          ].join(' | '),
        ),
      ].join('\n'),
    );
  }
  return prompts;
}

function buildPiSystemPrompt(containerInput: ContainerInput): string {
  const persona = containerInput.personaPrompt?.trim();
  return [
    persona ? `${persona}\n\n---` : '',
    '你是 FateClaw 的 Pi-backed Agent Runtime。',
    '你负责 AI session、上下文连续性、用户问题理解和最终推理。',
    '排盘是 Web/API 侧已经完成的确定性业务能力；不要自行调用或声称拥有排盘工具。',
    '涉及玄学问题时，直接在 Pi 循环内基于 Pi context 中的盘面 artifact、自贴盘面或追问上下文推理；不要调用或假设存在专用解读工具/解读 Skill。',
    '知识只通过本次请求授权的普通 Markdown Skill 读取，不能假设存在全局本地 Skill。',
    '完成用户请求后，直接用 assistant 回复最终答复。',
    '如果缺少关键参数，直接说明需要补充哪些信息。',
  ]
    .filter(Boolean)
    .join('\n\n');
}
