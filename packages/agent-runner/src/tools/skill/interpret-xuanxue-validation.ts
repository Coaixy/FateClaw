import type {
  ChatInputKind,
  ToolExecutionOptions,
  ToolResult,
} from '../../types.js';
import type { BoardSource } from './board-resolver.js';
import { createToolErrorResult } from './tool-error.js';
import type { UpstreamSkillRaw } from './interpret-xuanxue-board.js';

export const PASTED_BOARD_GUIDANCE =
  '请使用“自贴盘面”入口提交已有盘面，或使用“手动排盘”生成官方盘面后再解读。';

interface ValidateBoardDataInput {
  upstreamArtifact: UpstreamSkillRaw | null;
  boardSource: BoardSource;
  contentSource: 'skill' | 'user';
  inputKind?: ChatInputKind;
}

export interface OfficialBoardEvidenceInput {
  currentRequestUpstreamSkillRaw: UpstreamSkillRaw | null;
  historicalUpstreamSkillRaw: UpstreamSkillRaw | null;
  historicalBoardContent: string | null;
}

/**
 * 数据来源校验。
 *
 * Tier 1: content_source='user' → 仅自贴盘面入口通过，普通聊天拒绝
 * Tier 2: 有上游 artifact → 通过
 * Tier 3: boardSource 是官方 artifact / 历史官方盘面类型 → 通过
 *
 * content_source='skill' 不再根据 content 文本形态兜底放行；缺少官方盘面来源时拒绝。
 */
export function validateBoardDataPresence(
  input: ValidateBoardDataInput,
): { valid: true } | { valid: false; reason: string } {
  if (input.contentSource === 'user') {
    if (input.inputKind === 'user_pasted_board') return { valid: true };

    return {
      valid: false,
      reason:
        `普通聊天消息不能直接使用用户原文作为盘面依据解读。${PASTED_BOARD_GUIDANCE}`,
    };
  }

  if (input.upstreamArtifact) return { valid: true };

  if (
    input.boardSource === 'active_board_context' ||
    input.boardSource === 'current_request_artifact' ||
    input.boardSource === 'historical_artifact' ||
    input.boardSource === 'historical_board_output'
  ) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `未找到官方排盘 skill 的原始产出。${PASTED_BOARD_GUIDANCE}`,
  };
}

export function createMissingBoardDataResult(reason: string): ToolResult {
  return createToolErrorResult({
    code: 'SKILL.CONTENT_MISSING',
    kind: 'validation',
    retryable: false,
    userSafe: true,
    nextAction: 'stop',
    userMessage: PASTED_BOARD_GUIDANCE,
    internalMessage: `数据校验失败: ${reason}`,
  });
}

export function isValidPastedBoardInput(
  pastedBoard: ToolExecutionOptions['pastedBoard'] | undefined,
): pastedBoard is NonNullable<ToolExecutionOptions['pastedBoard']> {
  return (
    typeof pastedBoard?.category === 'string' &&
    pastedBoard.category.trim().length > 0 &&
    typeof pastedBoard.content === 'string' &&
    pastedBoard.content.trim().length > 0 &&
    typeof pastedBoard.question === 'string' &&
    pastedBoard.question.trim().length > 0
  );
}

export function hasOfficialBoardEvidence(
  input: OfficialBoardEvidenceInput,
): boolean {
  return Boolean(
    input.currentRequestUpstreamSkillRaw ||
      input.historicalUpstreamSkillRaw ||
      input.historicalBoardContent,
  );
}
