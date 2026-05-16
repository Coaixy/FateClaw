import type { AgentRuntimeDeps } from '../deps.js';
import {
  findOfficialCompositeSkillByTool,
  loadOfficialSkillMetadataList,
} from '../prompt/skills.js';
import { resolveCompositeSkillDirByTool } from '../tools/skill/composite-runtime.js';

export function runSkillScriptKey(args: Record<string, unknown>): string | null {
  const skillName = typeof args.skill_name === 'string' ? args.skill_name : '';
  const script = typeof args.script === 'string' ? args.script : '';
  if (!skillName || !script) return null;
  return `${skillName}/${script}`;
}

function resolveLoadSkillName(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string | null {
  if (toolName !== 'load_skill') return null;
  return typeof toolArgs.skill_name === 'string' ? toolArgs.skill_name : null;
}

function resolveSkillDependencyName(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string | null {
  if (toolName === 'run_skill_script') {
    return typeof toolArgs.skill_name === 'string' ? toolArgs.skill_name : null;
  }

  return resolveCompositeSkillDirByTool(toolName) ?? null;
}

export function resolveMissingLoadRepairSkillName(
  toolName: string,
  toolArgs: Record<string, unknown>,
  runtimeDeps?: AgentRuntimeDeps,
): string | null {
  // 只有真正声明 requiresLoad 的 skill，才需要在执行阶段做自动补偿。
  if (toolName === 'run_skill_script') {
    const skillName =
      typeof toolArgs.skill_name === 'string' ? toolArgs.skill_name : null;
    if (!skillName) return null;
    const skill = loadOfficialSkillMetadataList(undefined, runtimeDeps).find(
      (item) => item.dir === skillName,
    );
    return skill && skill.requiresLoad !== false ? skillName : null;
  }

  const compositeSkill = findOfficialCompositeSkillByTool(
    toolName,
    undefined,
    runtimeDeps,
  );
  return compositeSkill && compositeSkill.requiresLoad !== false
    ? compositeSkill.dir
    : null;
}

export function reorderToolCallsForSkillDependencies<TToolCall>(
  toolCalls: TToolCall[],
  getToolName: (toolCall: TToolCall) => string,
  getToolArgs: (toolCall: TToolCall) => Record<string, unknown>,
): TToolCall[] {
  if (toolCalls.length < 2) return toolCalls;

  const nodes = toolCalls.map((toolCall, index) => {
    const toolName = getToolName(toolCall);
    const toolArgs = getToolArgs(toolCall);
    return {
      toolCall,
      index,
      toolName,
      toolArgs,
      loadSkillName: resolveLoadSkillName(toolName, toolArgs),
      dependencySkillName: resolveSkillDependencyName(toolName, toolArgs),
    };
  });

  const outgoing = new Map<number, Set<number>>();
  const indegree = new Array<number>(nodes.length).fill(0);
  let hasDependencyEdge = false;

  for (let i = 0; i < nodes.length; i += 1) {
    const current = nodes[i];
    if (!current.dependencySkillName) continue;

    for (let j = i + 1; j < nodes.length; j += 1) {
      const candidateLoadSkill = nodes[j].loadSkillName;
      if (!candidateLoadSkill) continue;
      if (candidateLoadSkill !== current.dependencySkillName) continue;

      const targets = outgoing.get(j) ?? new Set<number>();
      if (targets.has(i)) continue;
      targets.add(i);
      outgoing.set(j, targets);
      indegree[i] += 1;
      hasDependencyEdge = true;
    }
  }

  if (!hasDependencyEdge) return toolCalls;

  const ready: number[] = [];
  for (let i = 0; i < indegree.length; i += 1) {
    if (indegree[i] === 0) ready.push(i);
  }
  ready.sort((a, b) => a - b);

  const ordered: TToolCall[] = [];
  while (ready.length > 0) {
    const currentIndex = ready.shift()!;
    ordered.push(nodes[currentIndex].toolCall);
    const targets = outgoing.get(currentIndex);
    if (!targets) continue;

    for (const targetIndex of targets) {
      indegree[targetIndex] -= 1;
      if (indegree[targetIndex] === 0) {
        ready.push(targetIndex);
        ready.sort((a, b) => a - b);
      }
    }
  }

  return ordered.length === toolCalls.length ? ordered : toolCalls;
}
