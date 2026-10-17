import { describe, expect, it } from 'vitest';

import {
  createChatDraftStore,
  type ChatDraftStorage,
} from '../../../../features/chat/hooks/use-chat-draft';

function createSyntheticStorage(): ChatDraftStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

const firstScope = { userId: 'user-a', sessionId: 'session-1' };

describe('chat drafts', () => {
  it('restores persisted drafts across remounts and isolates users and sessions', () => {
    const storage = createSyntheticStorage();
    const first = createChatDraftStore(() => storage);
    first.setDraft(firstScope, 'First session draft');
    first.setDraft({ userId: 'user-a', sessionId: 'session-2' }, 'Other session');
    first.setDraft({ userId: 'user-b', sessionId: 'session-1' }, 'Other user');
    first.setDraft({}, 'Anonymous draft');

    const remounted = createChatDraftStore(() => storage);
    expect(remounted.getDraft(firstScope)).toBe('First session draft');
    expect(
      remounted.getDraft({ userId: 'user-a', sessionId: 'session-2' }),
    ).toBe('Other session');
    expect(
      remounted.getDraft({ userId: 'user-b', sessionId: 'session-1' }),
    ).toBe('Other user');
    expect(remounted.getDraft({ userId: 'user-a' })).toBe('');
    expect(remounted.getDraft({})).toBe('Anonymous draft');
  });

  it('refreshes a revisited scope from persisted changes and deletions', () => {
    const storage = createSyntheticStorage();
    const first = createChatDraftStore(() => storage);
    first.setDraft(firstScope, 'Before leaving');
    const second = createChatDraftStore(() => storage);
    second.setDraft(firstScope, 'Updated elsewhere');

    first.refresh(firstScope);
    expect(first.getDraft(firstScope)).toBe('Updated elsewhere');
    second.setDraft(firstScope, '');
    first.refresh(firstScope);
    expect(first.getDraft(firstScope)).toBe('');
  });

  it('restores a failed send once without overwriting the next draft or another scope', () => {
    const storage = createSyntheticStorage();
    const store = createChatDraftStore(() => storage);
    store.setDraft(firstScope, 'Failed message');
    const submission = store.takeDraft(firstScope);
    expect(store.getDraft(firstScope)).toBe('');

    const typingAfterRemount = createChatDraftStore(() => storage);
    typingAfterRemount.setDraft(firstScope, (current) => `${current}Next question`);
    const anotherScope = { userId: 'user-b', sessionId: 'session-2' };
    store.setDraft(anotherScope, 'Keep this untouched');
    store.restoreDraft(submission);
    store.restoreDraft(submission);

    expect(store.getDraft(firstScope)).toBe('Failed message\n\nNext question');
    expect(store.getDraft(anotherScope)).toBe('Keep this untouched');
    const remounted = createChatDraftStore(() => storage);
    expect(remounted.getDraft(firstScope)).toBe('Failed message\n\nNext question');
  });

  it('adopts a new-session draft and restores its submission into the created session', () => {
    const storage = createSyntheticStorage();
    const store = createChatDraftStore(() => storage);
    const newScope = { userId: 'user-a' };
    store.setDraft(newScope, 'First message');
    const submission = store.takeDraft(newScope);
    store.setDraft(newScope, 'Question drafted while creating the session');

    store.adoptDraft(newScope, 'created-session', submission);
    store.setDraft(newScope, 'A different new conversation');
    store.restoreDraft(submission);
    store.adoptDraft(newScope, 'different-session', submission);

    expect(
      store.getDraft({ userId: 'user-a', sessionId: 'created-session' }),
    ).toBe('First message\n\nQuestion drafted while creating the session');
    expect(store.getDraft(newScope)).toBe('A different new conversation');
    expect(
      store.getDraft({ userId: 'user-a', sessionId: 'different-session' }),
    ).toBe('');
  });

  it('keeps adoption within the submitting user and the unsaved-session boundary', () => {
    const storage = createSyntheticStorage();
    const store = createChatDraftStore(() => storage);
    const newScope = { userId: 'user-a' };
    store.setDraft(newScope, 'First message');
    const submission = store.takeDraft(newScope);
    store.adoptDraft({ userId: 'user-b' }, 'other-user-session', submission);
    store.restoreDraft(submission);
    store.setDraft(firstScope, 'Existing conversation');
    store.adoptDraft(firstScope, 'other-session');

    expect(store.getDraft(newScope)).toBe('First message');
    expect(
      store.getDraft({ userId: 'user-b', sessionId: 'other-user-session' }),
    ).toBe('');
    expect(store.getDraft(firstScope)).toBe('Existing conversation');
  });

  it('keeps typing and failed-send restoration working when storage access or writes fail', () => {
    const storage = createSyntheticStorage();
    const inaccessible = createChatDraftStore(() => {
      throw new Error('Storage unavailable');
    });
    inaccessible.setDraft(firstScope, 'Editable text');
    const submission = inaccessible.takeDraft(firstScope);
    inaccessible.setDraft(firstScope, 'Next draft');
    inaccessible.restoreDraft(submission);
    inaccessible.refresh(firstScope);
    expect(inaccessible.getDraft(firstScope)).toBe('Editable text\n\nNext draft');

    const quotaLimited = createChatDraftStore(() => ({
      ...storage,
      setItem: () => {
        throw new Error('Quota exceeded');
      },
    }));
    quotaLimited.setDraft(firstScope, 'Unsaved but still editable');
    quotaLimited.refresh(firstScope);
    expect(quotaLimited.getDraft(firstScope)).toBe('Unsaved but still editable');
  });
});
