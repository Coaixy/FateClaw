import { latestSkillArtifactExcluding } from './artifact-store.js';
import { resolveEvidenceCategoryBySkill } from './evidence-policy.js';
import {
  boardSkillMatchesCategory,
} from './tools/skill/interpret-xuanxue-board.js';
import {
  formatBoardForAi,
  hasBoardFormatter,
} from './tools/skill/board-formatters/index.js';
import {
  getLatestFollowupInterpretation,
  type RequestScope,
} from './request-scope.js';
import { traceEvent } from './trace.js';
import type { ToolExecutionOptions, ToolInvocation } from './types.js';

interface InterpretContentCandidate {
  content: string;
  boardSkill?: string;
  source: 'current_artifact' | 'history_tool_context';
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

export function withExplicitInterpretContent(
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
