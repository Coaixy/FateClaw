import type { SkillContextEntryDto } from '@fateclaw/contracts/chat';

import { isDirectPaipanSkill } from './paipan-runtime.js';
import { formatOfficialPaipan } from './paipan-formatters.js';

const USER_PASTED_BOARD_SKILL_PREFIX = 'user-pasted-board::';

export interface SessionBoardContextDto {
  sourceMessageId: string;
  source: 'official_paipan' | 'user_pasted_board';
  skill: string;
  artifactTitle?: string;
  promptText: string;
  artifactData?: unknown;
  createdAt?: string;
  isCurrent?: boolean;
}

interface BoardMessageLike {
  id: string;
  tool_context?: string | null;
  timestamp?: string | null;
}

interface UserPastedBoardInputLike {
  category: string;
  content: string;
  question: string;
}

interface BuildSessionBoardContextsOptions {
  selectedBoardMessageId?: string;
  currentPastedBoard?: {
    sourceMessageId: string;
    pastedBoard: UserPastedBoardInputLike;
    createdAt?: string;
  };
}

export function parseStoredSkillContext(
  raw?: string | null,
): SkillContextEntryDto[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry.skill !== 'string' || typeof entry.output !== 'string') {
        return [];
      }
      return [
        {
          skill: entry.skill,
          output: entry.output,
          artifactType:
            typeof entry.artifactType === 'string'
              ? entry.artifactType
              : undefined,
          artifactTitle:
            typeof entry.artifactTitle === 'string'
              ? entry.artifactTitle
              : undefined,
          artifactData: entry.artifactData,
        },
      ];
    });
  } catch {
    return [];
  }
}

function isUserPastedBoardSkill(skill: string): boolean {
  return skill.startsWith(USER_PASTED_BOARD_SKILL_PREFIX);
}

function isBoardEntry(entry: SkillContextEntryDto): boolean {
  return (
    isDirectPaipanSkill(entry.skill) || isUserPastedBoardSkill(entry.skill)
  );
}

/**
 * 判断消息是否携带可作为会话盘面的 tool_context。
 *
 * 参数：
 * - message：待检查的会话消息。
 *
 * 返回：包含官方排盘或用户自贴盘面时返回 true。
 *
 * 注意：这里只做是否可选的轻量判断，真正注入 Pi 的盘面正文由 buildSessionBoardContexts 统一重建。
 */
export function messageHasBoardContext(message: BoardMessageLike): boolean {
  return parseStoredSkillContext(message.tool_context).some(isBoardEntry);
}

function isLikelyRawJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

function getPastedBoardContent(entry: SkillContextEntryDto): string {
  const data = entry.artifactData;
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    typeof (data as Record<string, unknown>).content === 'string'
  ) {
    return (data as Record<string, string>).content;
  }
  return entry.output;
}

function buildBoardContextFromEntry(
  message: BoardMessageLike,
  entry: SkillContextEntryDto,
): SessionBoardContextDto | null {
  if (isDirectPaipanSkill(entry.skill)) {
    const promptText = formatOfficialPaipan(entry.skill, entry.artifactData);
    const fallbackOutput = !isLikelyRawJson(entry.output)
      ? entry.output.trim()
      : '';
    const finalPromptText = promptText || fallbackOutput;
    if (!finalPromptText) return null;
    return {
      sourceMessageId: message.id,
      source: 'official_paipan',
      skill: entry.skill,
      artifactTitle: entry.artifactTitle,
      promptText: finalPromptText,
      artifactData: entry.artifactData,
      createdAt: message.timestamp ?? undefined,
    };
  }

  if (isUserPastedBoardSkill(entry.skill)) {
    const promptText = getPastedBoardContent(entry).trim();
    if (!promptText) return null;
    return {
      sourceMessageId: message.id,
      source: 'user_pasted_board',
      skill: entry.skill,
      artifactTitle: entry.artifactTitle,
      promptText,
      artifactData: entry.artifactData,
      createdAt: message.timestamp ?? undefined,
    };
  }

  return null;
}

function buildCurrentPastedBoardContext(args: {
  sourceMessageId: string;
  pastedBoard: UserPastedBoardInputLike;
  createdAt?: string;
}): SessionBoardContextDto {
  const skill = `${USER_PASTED_BOARD_SKILL_PREFIX}${args.pastedBoard.category}`;
  return {
    sourceMessageId: args.sourceMessageId,
    source: 'user_pasted_board',
    skill,
    artifactTitle: `自贴盘面: ${args.pastedBoard.category}`,
    promptText: args.pastedBoard.content,
    artifactData: {
      category: args.pastedBoard.category,
      content: args.pastedBoard.content,
      question: args.pastedBoard.question,
      source: 'user_pasted_board',
    },
    createdAt: args.createdAt,
  };
}

function getCreatedAtTime(board: SessionBoardContextDto): number {
  if (!board.createdAt) return 0;
  const time = new Date(board.createdAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function buildSessionBoardContexts(
  messages: BoardMessageLike[],
  options: BuildSessionBoardContextsOptions = {},
): SessionBoardContextDto[] {
  const boards = messages.flatMap((message) =>
    parseStoredSkillContext(message.tool_context).flatMap((entry) => {
      const board = buildBoardContextFromEntry(message, entry);
      return board ? [board] : [];
    }),
  );

  if (options.currentPastedBoard) {
    boards.push(buildCurrentPastedBoardContext(options.currentPastedBoard));
  }

  if (boards.length === 0) return [];

  const explicitCurrentId = options.selectedBoardMessageId
    ? boards.find(
        (board) => board.sourceMessageId === options.selectedBoardMessageId,
      )?.sourceMessageId
    : undefined;
  const fallbackCurrent = explicitCurrentId
    ? undefined
    : [...boards].sort((a, b) => getCreatedAtTime(b) - getCreatedAtTime(a))[0];
  const currentMessageId =
    explicitCurrentId ?? fallbackCurrent?.sourceMessageId;

  return boards
    .map((board) => ({
      ...board,
      isCurrent: board.sourceMessageId === currentMessageId,
    }))
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return getCreatedAtTime(b) - getCreatedAtTime(a);
    });
}
