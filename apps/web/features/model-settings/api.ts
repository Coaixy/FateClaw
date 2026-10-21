import type {
  ModelSettingsOverviewDto,
  ModelPoolKey,
} from '@fateclaw/contracts/model-settings';

import { requestJson } from '@/lib/http/client';
export type ModelSettingsOverview = ModelSettingsOverviewDto;

export const modelSettingsApi = {
  overview: () => requestJson<ModelSettingsOverview>('/api/model-settings'),
  setPreference: (poolKey: ModelPoolKey, sessionId?: string) =>
    requestJson<ModelSettingsOverview>('/api/model-settings/preference', {
      method: 'PUT',
      body: JSON.stringify({ pool_key: poolKey, session_id: sessionId }),
    }),
};
