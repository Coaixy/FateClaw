import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_RUNTIME_POLICY } from '@fateclaw/contracts/memory';

import {
  createMemoryPolicyDraft,
  parseMemoryPolicyDraft,
} from '@/components/memory/memory-policy';

describe('memory policy form', () => {
  it('round-trips a saved policy, keeping the CAS revision', () => {
    const policy = {
      ...DEFAULT_MEMORY_RUNTIME_POLICY,
      extraction_model_id: 'configured-provider-1',
      revision: 7,
    };
    expect(parseMemoryPolicyDraft(createMemoryPolicyDraft(policy))).toEqual(
      policy,
    );
  });

  it('rejects empty, nonpositive, fractional, or unsafe numeric values', () => {
    const draft = createMemoryPolicyDraft(DEFAULT_MEMORY_RUNTIME_POLICY);
    for (const key of ['daily_token_budget', 'recall_token_budget'] as const) {
      for (const invalid of ['', '0', '-1', '0.5', 'NaN', '9007199254740992']) {
        expect(parseMemoryPolicyDraft({ ...draft, [key]: invalid })).toBeNull();
      }
    }
    expect(
      parseMemoryPolicyDraft({ ...draft, daily_token_budget: '10000' })
        ?.daily_token_budget,
    ).toBe(10_000);
  });
});
