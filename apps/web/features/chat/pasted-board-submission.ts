import {
  buildUserPastedBoardRequest,
  type UserPastedBoardInput,
  type UserPastedBoardRequest,
} from './pasted-board-input';

type SendUserPastedBoardMessage = (
  content: string,
  request: Pick<UserPastedBoardRequest, 'inputKind' | 'pastedBoard'>,
) => Promise<boolean>;

interface StartUserPastedBoardSubmissionOptions {
  pastedBoard: UserPastedBoardInput;
  sendMessage: SendUserPastedBoardMessage;
  closeSheet: () => void;
  clearComposerInput?: () => void;
  onSendFailure: (error?: unknown) => void;
}

export function startUserPastedBoardSubmission({
  pastedBoard,
  sendMessage,
  closeSheet,
  clearComposerInput,
  onSendFailure,
}: StartUserPastedBoardSubmissionOptions): void {
  const request = buildUserPastedBoardRequest(pastedBoard);
  const sendPromise = sendMessage(request.content, {
    inputKind: request.inputKind,
    pastedBoard: request.pastedBoard,
  });

  closeSheet();

  void sendPromise
    .then((sent) => {
      if (!sent) {
        return;
      }
      clearComposerInput?.();
    })
    .catch(onSendFailure);
}
