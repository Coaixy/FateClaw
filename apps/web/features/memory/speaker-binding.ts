import type { MemoryScopeDto } from '@fateclaw/contracts/memory';

export interface SpeakerBindingDraft {
  base: MemoryScopeDto;
  displayName: string;
  subjectId: string | null;
  shareMemory: boolean;
}

export function createSpeakerBindingDraft(
  scope: MemoryScopeDto,
): SpeakerBindingDraft {
  return {
    base: scope,
    displayName: scope.display_name,
    subjectId: scope.speaker_subject_id,
    shareMemory: Boolean(
      scope.speaker_subject_id && scope.share_subject_memory,
    ),
  };
}

export type SpeakerBindingAction =
  | { type: 'reset'; scope: MemoryScopeDto }
  | { type: 'name'; value: string }
  | { type: 'subject'; value: string | null }
  | { type: 'share'; value: boolean };

export function speakerBindingReducer(
  draft: SpeakerBindingDraft,
  action: SpeakerBindingAction,
): SpeakerBindingDraft {
  switch (action.type) {
    case 'reset':
      return createSpeakerBindingDraft(action.scope);
    case 'name':
      return { ...draft, displayName: action.value };
    case 'subject':
      // Sharing consent belongs to the selected identity and cannot follow a rebinding.
      return action.value === draft.subjectId
        ? draft
        : { ...draft, subjectId: action.value, shareMemory: false };
    case 'share':
      return {
        ...draft,
        shareMemory: Boolean(draft.subjectId && action.value),
      };
  }
}
