import { latestSkillArtifactExcluding } from '../artifact-store.js';
import { resolveEvidenceCategoryBySkill } from '../evidence-policy.js';
import {
  boardSkillMatchesCategory,
} from '../tools/skill/interpret-xuanxue-board.js';
import {
  formatBoardForAi,
  hasBoardFormatter,
} from '../tools/skill/board-formatters/index.js';
import {
  getLatestFollowupInterpretation,
  type RequestScope,
} from '../request-scope.js';
import { traceEvent } from '../trace.js';
import type { ToolExecutionOptions, ToolInvocation } from '../types.js';
import { PI_INTERPRET_TOOL_NAME } from './interpret-tool-catalog.js';

interface InterpretContentCandidate {
  content: string;
  boardSkill?: string;
  source: 'current_artifact' | 'history_tool_context';
}

function buildFollowupDeltaExtraContext(
  followup: NonNullable<ReturnType<typeof getLatestFollowupInterpretation>>,
): string {
  const parts = [
    '【上一轮解读结论】',
    followup.interpretationOutput,
  ];
  if (followup.boardSkill && followup.boardOutput) {
    const boardOutput = hasBoardFormatter(followup.boardSkill)
      ? formatSkillContextForAi({
          skill: followup.boardSkill,
          output: followup.boardOutput,
          artifactData: followup.boardArtifactData,
        })
      : followup.boardOutput;
    parts.push(
      `【上一轮对应原盘来源】${followup.boardSkill}`,
      boardOutput,
    );
  }
  parts.push(
    '【本轮任务要求】这是对上一轮解读的追问或补充条件分析。请在上一轮结论基础上，重点说明新增条件带来的变化，不要把整盘从头完整重解一遍。',
  );
  return parts.join('\n\n');
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

function withFollowupExtraContext(
  invocation: ToolInvocation,
  requestScope: RequestScope,
): ToolInvocation {
  if (invocation.args.analysis_mode !== 'followup_delta') {
    return invocation;
  }
  const followup = getLatestFollowupInterpretation(requestScope);
  if (!followup?.interpretationOutput.trim()) return invocation;

  const extraContext = [
    typeof invocation.args.extra_context === 'string'
      ? invocation.args.extra_context
      : '',
    buildFollowupDeltaExtraContext(followup),
  ]
    .filter((item) => item.trim().length > 0)
    .join('\n\n');

  return {
    ...invocation,
    args: {
      ...invocation.args,
      extra_context: extraContext,
    },
  };
}

export function withPiInterpretContent(
  invocation: ToolInvocation,
  requestScope: RequestScope,
  options: ToolExecutionOptions,
): ToolInvocation {
  if (invocation.toolName !== PI_INTERPRET_TOOL_NAME) return invocation;
  const invocationWithFollowup = withFollowupExtraContext(
    invocation,
    requestScope,
  );
  const activeBoard = options.activeBoardContext;
  if (
    activeBoard &&
    typeof activeBoard.skill === 'string' &&
    typeof activeBoard.output === 'string' &&
    activeBoard.output.trim().length > 0
  ) {
    const category = resolveEvidenceCategoryBySkill(activeBoard.skill);
    const repairedInvocation: ToolInvocation = {
      ...invocationWithFollowup,
      args: {
        ...invocationWithFollowup.args,
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
      originalArgKeys: Object.keys(invocationWithFollowup.args),
    }, requestScope);

    return repairedInvocation;
  }
  if (
    typeof invocationWithFollowup.args.content === 'string' &&
    invocationWithFollowup.args.content.trim().length > 0
  ) {
    return invocationWithFollowup;
  }
  if (invocationWithFollowup.args.content_source === 'user') {
    return invocationWithFollowup;
  }

  const requestedCategory =
    typeof invocationWithFollowup.args.category === 'string'
      ? invocationWithFollowup.args.category
      : undefined;
  const candidate = resolveInterpretContentCandidate(
    requestScope,
    requestedCategory,
  );
  if (!candidate) return invocationWithFollowup;

  // 排盘后的解读要求 tool_call 本身携带模型可读盘面。
  // 这里在执行前补齐可观测入参，避免只靠准备工具内部再查上下文。
  const repairedInvocation: ToolInvocation = {
    ...invocationWithFollowup,
    args: {
      ...invocationWithFollowup.args,
      content: candidate.content,
      content_source: 'pi_context',
    },
  };

  traceEvent({
    type: 'interpret_xuanxue_args_content_injected',
    boardSkill: candidate.boardSkill,
    source: candidate.source,
    contentBytes: Buffer.byteLength(candidate.content, 'utf8'),
    originalArgKeys: Object.keys(invocationWithFollowup.args),
  }, requestScope);

  return repairedInvocation;
}
