import type {
  ChatInputKindDto,
  UserPastedBoardInputDto,
} from '@fateclaw/contracts/chat';

const PASTED_BOARD_PROMPT_MIN_CHARS = 200;
const PASTED_BOARD_PROMPT_MIN_LINES = 3;
const PASTED_BOARD_CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  八字排盘: '八字',
  紫微斗数排盘: '紫微',
  六爻排盘: '六爻',
  经占排盘: '经占',
  奇门遁甲排盘: '奇门',
  大六壬排盘: '大六壬',
};

export type ChatInputKind = ChatInputKindDto;
export type UserPastedBoardInput = UserPastedBoardInputDto;

export interface UserPastedBoardRequest {
  content: string;
  inputKind: 'user_pasted_board';
  pastedBoard: UserPastedBoardInput;
}

export function shouldPromptForPastedBoard(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lineCount = trimmed
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .filter(Boolean).length;
  return (
    lineCount >= PASTED_BOARD_PROMPT_MIN_LINES ||
    trimmed.length >= PASTED_BOARD_PROMPT_MIN_CHARS
  );
}

export function buildUserPastedBoardRequest(
  pastedBoard: UserPastedBoardInput,
): UserPastedBoardRequest {
  const category = normalizePastedBoardCategory(pastedBoard.category);
  return {
    content: pastedBoard.question,
    inputKind: 'user_pasted_board',
    pastedBoard: {
      ...pastedBoard,
      category,
    },
  };
}

export function normalizePastedBoardCategory(category: string): string {
  const trimmed = category.trim();
  if (!trimmed) return trimmed;
  return PASTED_BOARD_CATEGORY_ALIASES[trimmed] ?? trimmed;
}
