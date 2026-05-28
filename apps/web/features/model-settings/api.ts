import type {
  ModelPiApiDto,
  ModelSettingsOverviewDto,
  OfficialModelDto,
  UserModelSelectionDto,
} from '@fateclaw/contracts/model-settings';

import { requestJson } from '@/lib/http/client';

export type ModelPiApi = ModelPiApiDto;
export type OfficialModel = OfficialModelDto;
export type ModelSettingsOverview = ModelSettingsOverviewDto;
export type UserModelSelection = UserModelSelectionDto;

export const modelSettingsApi = {
  overview: () => requestJson<ModelSettingsOverview>('/api/model-settings'),
  officialModels: () =>
    requestJson<OfficialModel[]>('/api/model-settings/official-models'),
  saveCustom: (data: {
    pi_api: ModelPiApi;
    base_url?: string | null;
    model_name: string;
    context_window_tokens?: number | null;
    api_key?: string;
  }) =>
    requestJson<ModelSettingsOverview['custom']>('/api/model-settings/custom', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  saveCustomSecret: (data: { api_key: string }) =>
    requestJson<{ success: boolean }>('/api/model-settings/custom/secret', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  select: (data: {
    source: 'custom' | 'official';
    official_model_id?: string | null;
  }) =>
    requestJson<UserModelSelection>('/api/model-settings/selection', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};
