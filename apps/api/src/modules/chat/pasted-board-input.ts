import type {
  ChatInputKindDto,
  ChatSessionSendRequestDto,
  UserPastedBoardInputDto,
} from '@nanoclaw/contracts/chat';

export type ChatInputKind = ChatInputKindDto;
export type UserPastedBoardInput = UserPastedBoardInputDto;

export interface NormalizedChatSessionMessageInput {
  content: string;
  selectedBoardMessageId?: string;
  inputKind: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
}

type NormalizeResult =
  | { ok: true; data: NormalizedChatSessionMessageInput }
  | { ok: false; statusCode: 400; error: string };

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePastedBoard(value: unknown): NormalizeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, statusCode: 400, error: '自贴盘面数据不能为空' };
  }

  const record = value as Record<string, unknown>;
  const category = trimOptionalString(record.category);
  const content = trimOptionalString(record.content);
  const question = trimOptionalString(record.question);

  if (!category) {
    return { ok: false, statusCode: 400, error: '自贴盘面术数类型不能为空' };
  }
  if (!content) {
    return { ok: false, statusCode: 400, error: '自贴盘面原文不能为空' };
  }
  if (!question) {
    return { ok: false, statusCode: 400, error: '自贴盘面问题不能为空' };
  }

  return {
    ok: true,
    data: {
      content: question,
      inputKind: 'user_pasted_board',
      pastedBoard: { category, content, question },
    },
  };
}

export function normalizeChatSessionMessageBody(
  body: unknown,
): NormalizeResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, statusCode: 400, error: '消息内容不能为空' };
  }

  const typedBody = body as ChatSessionSendRequestDto;
  const inputKind = typedBody.input_kind ?? 'normal';
  if (inputKind !== 'normal' && inputKind !== 'user_pasted_board') {
    return { ok: false, statusCode: 400, error: '未知消息输入类型' };
  }

  if (inputKind === 'user_pasted_board') {
    const pastedBoardResult = normalizePastedBoard(
      (body as Record<string, unknown>).pasted_board,
    );
    if (!pastedBoardResult.ok) return pastedBoardResult;
    return {
      ok: true,
      data: {
        ...pastedBoardResult.data,
        selectedBoardMessageId: trimOptionalString(
          typedBody.selected_board_message_id,
        ),
      },
    };
  }

  const content = trimOptionalString(typedBody.content);
  if (!content) {
    return { ok: false, statusCode: 400, error: '消息内容不能为空' };
  }

  return {
    ok: true,
    data: {
      content,
      selectedBoardMessageId: trimOptionalString(
        typedBody.selected_board_message_id,
      ),
      inputKind: 'normal',
      pastedBoard: undefined,
    },
  };
}
