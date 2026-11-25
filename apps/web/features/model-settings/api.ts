import type {
  ModelSettingsOverviewDto,
  ModelPoolKey,
} from '@fateclaw/contracts/model-settings';

import { clearChatSessionsCache } from '@/features/chat/api';
import { createAuthScopedInFlightCache } from '@/lib/auth-scoped-cache';
import { requestJson } from '@/lib/http/client';
export type ModelSettingsOverview = ModelSettingsOverviewDto;

const modelSettingsRequestCache =
  createAuthScopedInFlightCache<ModelSettingsOverview>();

export const modelSettingsApi = {
  overview: () =>
    modelSettingsRequestCache.get(() =>
      requestJson<ModelSettingsOverview>('/api/model-settings'),
    ),
  setPreference: (poolKey: ModelPoolKey, sessionId?: string) =>
    requestJson<ModelSettingsOverview>('/api/model-settings/preference', {
      method: 'PUT',
      body: JSON.stringify({ pool_key: poolKey, session_id: sessionId }),
    }).finally(() => {
      modelSettingsRequestCache.clear();
      if (sessionId) clearChatSessionsCache();
    }),
};
