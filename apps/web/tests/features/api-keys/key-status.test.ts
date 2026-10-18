import { describe, expect, it } from 'vitest';

import { getApiKeyStatus } from '@/features/api-keys/key-status';

const NOW = Date.parse('2026-10-18T12:00:00Z');

describe('API key availability', () => {
  it('marks an unrevoked key as expired at its exact expiry time', () => {
    const key = {
      status: 'active',
      expires_at: '2026-10-18T12:00:00Z',
    } as const;
    expect(getApiKeyStatus(key, NOW - 1)).toBe('active');
    expect(getApiKeyStatus(key, NOW)).toBe('expired');
  });

  it('keeps revocation visible after the expiry date', () => {
    expect(
      getApiKeyStatus(
        { status: 'revoked', expires_at: '2026-10-17T12:00:00Z' },
        NOW,
      ),
    ).toBe('revoked');
  });

  it('allows an unrevoked key with no expiry', () => {
    expect(getApiKeyStatus({ status: 'active', expires_at: null }, NOW)).toBe(
      'active',
    );
  });
});
