import type { ApiKeyDto } from '@fateclaw/contracts/api-keys';

export function getApiKeyStatus(
  key: Pick<ApiKeyDto, 'status' | 'expires_at'>,
  now = Date.now(),
): 'active' | 'expired' | 'revoked' {
  if (key.status === 'revoked') return 'revoked';
  if (key.expires_at && new Date(key.expires_at).getTime() <= now)
    return 'expired';
  return 'active';
}
