import type {
  ModelSettingsOverviewDto,
  OfficialModelDto,
} from '@fateclaw/contracts/model-settings';

import { requestJson } from '@/lib/http/client';

export type OfficialModel = OfficialModelDto;
export type ModelSettingsOverview = ModelSettingsOverviewDto;

export const modelSettingsApi = {
  overview: () => requestJson<ModelSettingsOverview>('/api/model-settings'),
};
