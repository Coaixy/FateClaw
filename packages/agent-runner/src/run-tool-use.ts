import {
  appendArtifact,
  latestSkillArtifactExcluding,
} from './artifact-store.js';
import { resolveEvidenceCategoryBySkill } from './evidence-policy.js';
import { log } from './io.js';
import { throwIfAborted } from './timeout.js';
import { appendTranscriptEvent } from './transcript-store.js';
import { traceEvent } from './trace.js';
import { boardSkillMatchesCategory } from './tools/skill/interpret-xuanxue-board.js';
import {
  formatBoardForAi,
  hasBoardFormatter,
} from './tools/skill/board-formatters/index.js';
import { resolveCompositeSkillDirByTool } from './tools/skill/composite-runtime.js';
import {
  getLatestFollowupInterpretation,
  recordProducedEvidence,
  type RequestScope,
} from './request-scope.js';
import type {
  Artifact,
  ArtifactHint,
  SkillContextEntry,
  ToolExecutionOptions,
  ToolInvocation,
  ToolResult,
} from './types.js';

export interface RunToolUseResult {
  result: ToolResult;
  artifact?: Artifact;
  skillContextEntry?: SkillContextEntry;
}

interface InterpretContentCandidate {
  content: string;
  boardSkill?: string;
  source: 'current_artifact' | 'history_tool_context';
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 判断某次工具调用是否"调用了 skill"（无论通过 run_skill_script 还是封装工具）。 */
function resolveInvokedSkill(invocation: ToolInvocation): string | undefined {
  if (
    invocation.toolName === 'run_skill_script' &&
    typeof invocation.args.skill_name === 'string'
  ) {
    return invocation.args.skill_name;
  }
  return resolveCompositeSkillDirByTool(
    invocation.toolName,
    undefined,
  );
}

/** 解读类 skill 不产生 artifact，只有排盘类 skill 的结果才需要存储 */
const SKILL_ARTIFACT_EXCLUSIONS = new Set(['xuanxue-jiedu']);

function buildArtifactHint(
  invocation: ToolInvocation,
): ArtifactHint | undefined {
  if (invocation.artifactHint) return invocation.artifactHint;

  // 排盘类 skill 的工具（run_skill_script 或封装工具）生成 artifact
  // 解读类 skill（如 xuanxue-jiedu）不生成 artifact
  const skillName = resolveInvokedSkill(invocation);
  if (skillName && !SKILL_ARTIFACT_EXCLUSIONS.has(skillName)) {
    return {
      type: `skill.${skillName}`,
      title: `Skill 结果: ${skillName}`,
      producer: skillName,
    };
  }

  return undefined;
}

function buildArtifact(
  invocation: ToolInvocation,
  hint: ArtifactHint,
  output: string,
): Artifact {
  const skillName = resolveInvokedSkill(invocation);
  return {
    id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: hint.type,
    title: hint.title,
    producer: hint.producer || invocation.toolName,
    category: skillName ? resolveEvidenceCategoryBySkill(skillName) || undefined : undefined,
    payload: parseJsonSafe(output),
    rawOutput: output,
    createdAt: new Date().toISOString(),
  };
}

function buildSkillContextEntry(artifact: Artifact): SkillContextEntry {
  return {
    skill: artifact.producer,
    output: artifact.rawOutput,
    artifactType: artifact.type,
    artifactTitle: artifact.title,
    artifactData: artifact.payload,
  };
}

function buildSkillContextEntryFromToolResult(
  skillName: string,
  output: string,
): SkillContextEntry {
  return {
    skill: skillName,
    output,
    artifactType: `skill.${skillName}`,
    artifactTitle: `Skill 结果: ${skillName}`,
    // 解读类 skill 不生成可渲染 artifact，但仍保留结构化上下文，便于后续追问复用。
    artifactData: parseJsonSafe(output),
  };
}

function stringifyToolContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : null;
  }
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatSkillContextForAi(entry: {
  skill: string;
  output: string;
  artifactData?: unknown;
}): string {
  return formatBoardForAi({
    skill: entry.skill,
    output: entry.output,
    artifactData: entry.artifactData,
  });
}

function boardSkillMatchesRequestedCategory(
  boardSkill: string | undefined,
  requestedCategory: string | undefined,
): boolean {
  return boardSkillMatchesCategory(boardSkill, requestedCategory);
}

function resolveInterpretContentCandidate(
  requestScope: RequestScope,
  requestedCategory: string | undefined,
): InterpretContentCandidate | null {
  const currentArtifact = latestSkillArtifactExcluding(requestScope, [
    'xuanxue-jiedu',
  ]);
  if (
    currentArtifact &&
    boardSkillMatchesRequestedCategory(
      currentArtifact.producer,
      requestedCategory,
    )
  ) {
    const content =
      hasBoardFormatter(currentArtifact.producer)
        ? formatBoardForAi({
            skill: currentArtifact.producer,
            output: currentArtifact.rawOutput,
            artifactData: currentArtifact.payload,
          })
        : stringifyToolContent(currentArtifact.rawOutput) ??
          stringifyToolContent(currentArtifact.payload);
    if (content) {
      return {
        content,
        boardSkill: currentArtifact.producer,
        source: 'current_artifact',
      };
    }
  }

  const latestFollowup = getLatestFollowupInterpretation(requestScope);
  if (
    !boardSkillMatchesRequestedCategory(
      latestFollowup?.boardSkill,
      requestedCategory,
    )
  ) {
    return null;
  }
  const historicalContent =
    latestFollowup?.boardSkill && hasBoardFormatter(latestFollowup.boardSkill)
      ? formatSkillContextForAi({
          skill: latestFollowup.boardSkill,
          output:
            latestFollowup.boardOutput ??
            stringifyToolContent(latestFollowup.boardArtifactData) ??
            '',
          artifactData: latestFollowup.boardArtifactData,
        })
      : stringifyToolContent(latestFollowup?.boardOutput) ??
        stringifyToolContent(latestFollowup?.boardArtifactData);
  if (!historicalContent) return null;

  return {
    content: historicalContent,
    boardSkill: latestFollowup?.boardSkill,
    source: 'history_tool_context',
  };
}

function withExplicitInterpretContent(
  invocation: ToolInvocation,
  requestScope: RequestScope,
  options: ToolExecutionOptions,
): ToolInvocation {
  if (invocation.toolName !== 'interpret_xuanxue') return invocation;
  const activeBoard = options.activeBoardContext;
  if (
    activeBoard &&
    typeof activeBoard.skill === 'string' &&
    typeof activeBoard.output === 'string' &&
    activeBoard.output.trim().length > 0
  ) {
    const category = resolveEvidenceCategoryBySkill(activeBoard.skill);
    const repairedInvocation: ToolInvocation = {
      ...invocation,
      args: {
        ...invocation.args,
        content: formatSkillContextForAi(activeBoard),
        content_source: 'skill',
        ...(category ? { category } : {}),
      },
    };

    traceEvent({
      type: 'interpret_xuanxue_args_content_injected',
      boardSkill: activeBoard.skill,
      source: 'active_board_context',
      contentBytes: Buffer.byteLength(
        repairedInvocation.args.content as string,
        'utf8',
      ),
      sourceMessageId: activeBoard.sourceMessageId,
      originalArgKeys: Object.keys(invocation.args),
    }, requestScope);

    return repairedInvocation;
  }
  if (
    typeof invocation.args.content === 'string' &&
    invocation.args.content.trim().length > 0
  ) {
    return invocation;
  }
  if (invocation.args.content_source === 'user') {
    return invocation;
  }

  const requestedCategory =
    typeof invocation.args.category === 'string'
      ? invocation.args.category
      : undefined;
  const candidate = resolveInterpretContentCandidate(
    requestScope,
    requestedCategory,
  );
  if (!candidate) return invocation;

  // 排盘后的解读要求 tool_call 本身携带模型可读盘面。
  // 这里在执行前补齐可观测入参，避免只靠 interpret_xuanxue 内部再查上下文。
  const repairedInvocation: ToolInvocation = {
    ...invocation,
    args: {
      ...invocation.args,
      content: candidate.content,
      content_source: 'skill',
    },
  };

  traceEvent({
    type: 'interpret_xuanxue_args_content_injected',
    boardSkill: candidate.boardSkill,
    source: candidate.source,
    contentBytes: Buffer.byteLength(candidate.content, 'utf8'),
    originalArgKeys: Object.keys(invocation.args),
  }, requestScope);

  return repairedInvocation;
}

export async function runToolUse(
  invocation: ToolInvocation,
  options: ToolExecutionOptions = {},
): Promise<RunToolUseResult> {
  if (!options.requestScope) {
    throw new Error('runToolUse 缺少 requestScope');
  }
  if (!options.toolRegistry) {
    throw new Error('runToolUse 缺少 toolRegistry');
  }
  invocation = withExplicitInterpretContent(
    invocation,
    options.requestScope,
    options,
  );
  throwIfAborted(options.signal, `工具 ${invocation.toolName} 已取消`);
  appendTranscriptEvent(options.requestScope, { type: 'tool_use', invocation });

  traceEvent({
    type: 'tool_call',
    toolName: invocation.toolName,
    args: invocation.args,
    source: invocation.source,
  }, options.requestScope);

  const result = await options.toolRegistry.executeTool(
    invocation.toolName,
    invocation.args,
    options,
  );
  if (options.signal?.aborted) {
    log(`工具 ${invocation.toolName} 已取消，丢弃迟到结果`);
    throwIfAborted(options.signal, `工具 ${invocation.toolName} 已取消`);
  }
  const ok = !result.isError;
  const invokedSkill = resolveInvokedSkill(invocation);
  const artifactHint =
    ok && !result.skipArtifact ? buildArtifactHint(invocation) : undefined;
  const pendingArtifact =
    ok && artifactHint
      ? buildArtifact(invocation, artifactHint, result.output)
      : undefined;
  if (pendingArtifact && hasBoardFormatter(pendingArtifact.producer)) {
    result.modelOutput = formatBoardForAi({
      skill: pendingArtifact.producer,
      output: pendingArtifact.rawOutput,
      artifactData: pendingArtifact.payload,
    });
  }
  const artifact =
    pendingArtifact
      ? appendArtifact(options.requestScope, pendingArtifact)
      : undefined;
  // 所有"调用 skill 的工具"（run_skill_script + 封装工具如 interpret_xuanxue）都生成 skillContext
  const skillContextEntry =
    ok && invokedSkill && !result.skipArtifact
      ? artifact
        ? buildSkillContextEntry(artifact)
        : buildSkillContextEntryFromToolResult(invokedSkill, result.output)
      : undefined;
  if (artifact?.category) {
    recordProducedEvidence(
      options.requestScope,
      artifact.category,
      artifact.producer,
    );
  }

  appendTranscriptEvent(options.requestScope, {
    type: 'tool_result',
    invocationId: invocation.id,
    ok,
    output: result.output,
    modelOutput: result.modelOutput,
    artifactId: artifact?.id,
    errorCode: result.error?.code,
  });

  traceEvent({
    type: 'tool_result',
    toolName: invocation.toolName,
    isError: !ok,
    errorCode: result.error?.code,
    output: result.output.slice(0, 200),
    modelOutputPreview: result.modelOutput?.slice(0, 2000),
    modelOutputBytes:
      result.modelOutput !== undefined
        ? Buffer.byteLength(result.modelOutput, 'utf8')
        : undefined,
    artifactType: artifact?.type,
    source: invocation.source,
  }, options.requestScope);

  return { result, artifact, skillContextEntry };
}
