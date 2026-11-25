import { adminRequest } from './admin-http';
import type {
  AdminSession,
  AdminStatusStats,
  AdminRechargeStatsRange,
  GlobalStats,
  AdminSystemConfigOverview,
  AdminModelSettingsUpdate,
  AdminRuntimeStatus,
} from './admin-api';
import type {
  RuntimeConfigDto,
  RuntimeConfigUpdateDto,
} from '@fateclaw/contracts/model-settings';

export const adminSystemApi = {
  verify: () =>
    adminRequest<AdminSession>('/api/admin/verify', {
      method: 'POST',
    }),
  runtimeStatus: () =>
    adminRequest<AdminRuntimeStatus>('/api/admin/runtime-status'),
  stats: (options?: {
    rechargeRange?: AdminRechargeStatsRange;
    rechargeStartDate?: string;
    rechargeEndDate?: string;
  }) => {
    const params = new URLSearchParams();
    if (options?.rechargeRange) {
      params.set('recharge_range', options.rechargeRange);
    }
    if (options?.rechargeStartDate) {
      params.set('recharge_start_date', options.rechargeStartDate);
    }
    if (options?.rechargeEndDate) {
      params.set('recharge_end_date', options.rechargeEndDate);
    }
    const query = params.toString();
    return adminRequest<GlobalStats>(
      `/api/admin/stats${query ? `?${query}` : ''}`,
    );
  },
  status: () => adminRequest<AdminStatusStats>('/api/admin/status'),
  systemConfig: () =>
    adminRequest<AdminSystemConfigOverview>('/api/admin/system-config'),
  runtimeConfig: () =>
    adminRequest<RuntimeConfigDto>('/api/admin/system-config/runtime'),
  updateRuntimeConfig: (data: RuntimeConfigUpdateDto) =>
    adminRequest<RuntimeConfigDto>('/api/admin/system-config/runtime', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  benefitModelSettings: () =>
    adminRequest<AdminSystemConfigOverview>('/api/admin/system-config/benefit'),
  updateBenefitModelSettings: (data: AdminModelSettingsUpdate) =>
    adminRequest<AdminSystemConfigOverview>(
      '/api/admin/system-config/benefit',
      { method: 'PUT', body: JSON.stringify(data) },
    ),
  updateModelSettings: (data: AdminModelSettingsUpdate) =>
    adminRequest<AdminSystemConfigOverview>('/api/admin/system-config/model', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};
