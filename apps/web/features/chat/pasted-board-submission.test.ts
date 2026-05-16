import { describe, expect, it, vi } from 'vitest';

import { startUserPastedBoardSubmission } from './pasted-board-submission';
import type { UserPastedBoardInput } from './pasted-board-input';

const pastedBoard: UserPastedBoardInput = {
  category: '八字',
  content: '乾造：甲子 乙丑 丙寅 丁卯',
  question: '看看事业',
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('startUserPastedBoardSubmission', () => {
  it('closes the sheet while the message send is still pending', async () => {
    const sendResult = createDeferred<boolean>();
    const events: string[] = [];
    const sendMessage = vi.fn(() => {
      events.push('send');
      return sendResult.promise;
    });

    startUserPastedBoardSubmission({
      pastedBoard,
      sendMessage,
      clearSelectedBoard: () => events.push('clear-board'),
      closeSheet: () => events.push('close-sheet'),
      clearComposerInput: () => events.push('clear-input'),
      onSendFailure: () => events.push('send-failure'),
    });

    expect(sendMessage).toHaveBeenCalledWith('看看事业', {
      inputKind: 'user_pasted_board',
      pastedBoard,
    });
    expect(events).toEqual(['send', 'close-sheet']);

    sendResult.resolve(true);
    await sendResult.promise;
    await Promise.resolve();

    expect(events).toEqual([
      'send',
      'close-sheet',
      'clear-board',
      'clear-input',
    ]);
  });

  it('reports send failures explicitly', async () => {
    const error = new Error('send failed');
    const sendResult = createDeferred<boolean>();
    const onSendFailure = vi.fn();

    startUserPastedBoardSubmission({
      pastedBoard,
      sendMessage: () => sendResult.promise,
      clearSelectedBoard: vi.fn(),
      closeSheet: vi.fn(),
      onSendFailure,
    });

    sendResult.reject(error);

    await expect(sendResult.promise).rejects.toThrow('send failed');
    await Promise.resolve();

    expect(onSendFailure).toHaveBeenCalledWith(error);
  });
});
