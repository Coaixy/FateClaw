import { describe, expect, it } from 'vitest';
import {
  buildRegistrationInviteLink,
  readRegistrationInviteFragment,
} from '../../../features/invitations/links';

describe('invitation link confidentiality', () => {
  it('prefills registration without placing the code in the HTTP request target', () => {
    const code = '0123456789ABCDEF01234567';
    const url = new URL(
      buildRegistrationInviteLink('https://web.example.test', code),
    );
    expect(url.origin).toBe('https://web.example.test');
    expect(url.pathname).toBe('/login');
    expect(url.search).toBe('');
    expect(url.pathname + url.search).not.toContain(code);
    expect(readRegistrationInviteFragment(url.hash)).toBe(code);
  });
});
