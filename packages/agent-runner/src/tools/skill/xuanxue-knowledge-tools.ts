import { getContext } from '../../context.js';
import { getRequestId } from '../../request-scope.js';
import type {
  ToolExecutionOptions,
  ToolResult,
  ToolSpec,
} from '../../types.js';
import {
  executeKnowledgeTool,
  LIST_SECTIONS_TOOL,
  READ_SECTION_TOOL,
  type KnowledgeSkillBundle,
} from './xuanxue-knowledge.js';

export interface XuanxueKnowledgeToolState {
  queryable: KnowledgeSkillBundle[];
}

const stateByLoopRun = new Map<string, XuanxueKnowledgeToolState>();

function keyFromOptions(options?: ToolExecutionOptions): string | null {
  return options?.loopRunId ?? null;
}

export function setXuanxueKnowledgeToolState(
  loopRunId: string,
  state: XuanxueKnowledgeToolState,
): void {
  stateByLoopRun.set(loopRunId, state);
}

export function clearXuanxueKnowledgeToolState(loopRunId: string): void {
  stateByLoopRun.delete(loopRunId);
}

async function pushKnowledgeReadProgress(args: {
  options?: ToolExecutionOptions;
  bundles: KnowledgeSkillBundle[];
  toolArgs: Record<string, unknown>;
}): Promise<void> {
  if (args.options?.requestScope && args.options.runtimeDeps) {
    const requestId = getRequestId(args.options.requestScope);
    if (!requestId) return;
    const skillDir =
      typeof args.toolArgs.skill_dir === 'string'
        ? args.toolArgs.skill_dir
        : '';
    const sectionTitle =
      typeof args.toolArgs.section_title === 'string'
        ? args.toolArgs.section_title
        : '';
    const bundle = args.bundles.find((item) => item.skill_dir === skillDir);
    const { accountId } = getContext();
    await args.options.runtimeDeps.messageBus.pushOutbox(accountId, {
      type: 'progress',
      accountId,
      requestId,
      text: `检索中：${bundle?.skill_name ?? skillDir}/${sectionTitle}`,
      timestamp: new Date().toISOString(),
      metadata: {
        kind: 'knowledge_section',
        stage: 'knowledge_section',
        skillDir,
        skillName: bundle?.skill_name,
        sectionTitle,
      },
    });
  }
}

export function resolveXuanxueKnowledgeToolBundles(
  options?: ToolExecutionOptions,
): KnowledgeSkillBundle[] {
  const key = keyFromOptions(options);
  if (!key) return [];
  return stateByLoopRun.get(key)?.queryable ?? [];
}

export async function executeXuanxueKnowledgeTool(
  toolName: 'list_knowledge_sections' | 'read_knowledge_section',
  args: Record<string, unknown>,
  options?: ToolExecutionOptions,
): Promise<ToolResult> {
  const bundles = resolveXuanxueKnowledgeToolBundles(options);
  const result = executeKnowledgeTool(toolName, args, bundles);
  if (toolName === 'read_knowledge_section') {
    await pushKnowledgeReadProgress({ options, bundles, toolArgs: args });
  }
  return {
    output: result.output,
    isError: result.isError,
    passthroughSafe: true,
  };
}

function createKnowledgeToolSpec(
  definition: typeof LIST_SECTIONS_TOOL | typeof READ_SECTION_TOOL,
): ToolSpec {
  return {
    definition,
    prompt:
      definition.function.name === 'list_knowledge_sections'
        ? '列出本轮玄学解读可查询的用户知识库章节。仅在玄学解读准备工具提示有 queryable 知识时使用。'
        : '读取本轮玄学解读可查询的用户知识库章节。参数必须来自目录中的 skill_dir 与 section_title。',
    executionMode: 'serial',
    async execute(args, options): Promise<ToolResult> {
      const toolName =
        definition.function.name === 'read_knowledge_section'
          ? 'read_knowledge_section'
          : 'list_knowledge_sections';
      return executeXuanxueKnowledgeTool(
        toolName,
        args,
        options,
      );
    },
  };
}

export const listKnowledgeSectionsTool = createKnowledgeToolSpec(
  LIST_SECTIONS_TOOL,
);
export const readKnowledgeSectionTool = createKnowledgeToolSpec(
  READ_SECTION_TOOL,
);
