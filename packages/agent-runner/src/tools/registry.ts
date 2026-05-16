/**
 * 工具注册中心。
 *
 * 由显式的 registry snapshot 统一承载定义列表、prompt 生成、执行入口和调度语义。
 * 每个请求持有自己的 snapshot，避免模块加载时的静态注册副作用。
 */

import type { AgentRuntimeDeps } from '../deps.js';
import type {
  ToolDefinition,
  ToolExecutionMode,
  ToolExecutionOptions,
  ToolRegistrySnapshot,
  ToolResult,
  ToolSpec,
} from '../types.js';

// Conversation tools
import { sendMessage } from './conversation/send-message.js';

// Memory tools
import { readMemory } from './memory/read.js';
import { writeMemory } from './memory/write.js';
import { SKILLS_DIR } from '../paths.js';

// Reminder tools
import { scheduleReminder } from './reminder/schedule.js';
import { listReminders } from './reminder/list.js';
import { manageReminder } from './reminder/manage.js';

// Skill tools
import { loadSkill } from './skill/load.js';
import { runSkillScript } from './skill/run-script.js';
import { manageSkill } from './skill/manage.js';
import {
  buildCompositeToolSpecsForSkills,
  buildCompositeToolSpecsForDir,
  logCompositeToolDiagnostics,
} from './skill/composite-tools.js';
import {
  listKnowledgeSectionsTool,
  readKnowledgeSectionTool,
} from './skill/xuanxue-knowledge-tools.js';

// Utility tools
import { getTimeDetail } from './utility/get-time-detail.js';
import { convertTime } from './utility/convert-time.js';
import { recallHistory } from './utility/recall-history.js';
import { convertCalendar } from './utility/convert-calendar.js';
import { reverseBazi } from './utility/reverse-bazi.js';
import { generateRandom } from './utility/generate-random.js';

const baseTools: ToolSpec[] = [
  sendMessage,
  readMemory,
  writeMemory,
  scheduleReminder,
  listReminders,
  manageReminder,
  loadSkill,
  runSkillScript,
  manageSkill,
  getTimeDetail,
  convertTime,
  recallHistory,
  convertCalendar,
  reverseBazi,
  generateRandom,
];

function resolveExecutionMode(spec: ToolSpec | undefined): ToolExecutionMode {
  return spec?.executionMode ?? 'parallel';
}

export interface CreateToolRegistryOptions {
  skillsDir?: string;
  logDiagnostics?: boolean;
  deps?: AgentRuntimeDeps;
}

export function createToolRegistry(
  options: CreateToolRegistryOptions = {},
): ToolRegistrySnapshot {
  const { specs: compositeToolSpecs, diagnostics } = options.deps
    ? buildCompositeToolSpecsForSkills(
        options.deps.skillCatalog.listOfficialSkillMetadata(
          options.skillsDir ?? SKILLS_DIR,
        ),
      )
    : options.skillsDir
      ? buildCompositeToolSpecsForDir(options.skillsDir)
      : buildCompositeToolSpecsForDir(SKILLS_DIR);

  if (options.logDiagnostics !== false) {
    logCompositeToolDiagnostics(diagnostics);
  }

  const allTools: ToolSpec[] = [
    ...baseTools,
    ...compositeToolSpecs,
    listKnowledgeSectionsTool,
    readKnowledgeSectionTool,
  ];
  const toolMap = new Map<string, ToolSpec>(
    allTools.map((tool) => [tool.definition.function.name, tool]),
  );
  const protectedToolNames = new Set<string>(['run_skill_script']);
  for (const tool of compositeToolSpecs) {
    protectedToolNames.add(tool.definition.function.name);
  }

  return {
    toolDefinitions: allTools.map((tool) => tool.definition),

    buildToolPrompts(): string {
      return allTools
        .map((tool) => `### ${tool.definition.function.name}\n${tool.prompt}`)
        .join('\n\n');
    },

    async executeTool(
      name: string,
      args: Record<string, unknown>,
      execOptions?: ToolExecutionOptions,
    ): Promise<ToolResult> {
      const spec = toolMap.get(name);
      if (!spec) return { output: `未知工具: ${name}`, isError: true };
      return spec.execute(args, execOptions);
    },

    getExecutionMode(name: string): ToolExecutionMode {
      return resolveExecutionMode(toolMap.get(name));
    },

    getProtectedToolNames(): Set<string> {
      return new Set(protectedToolNames);
    },
  };
}
