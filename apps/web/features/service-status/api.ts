import type { ServiceStatusOverviewDto } from '@fateclaw/contracts/service-status';
import { requestJson } from '@/lib/http/client';

export const serviceStatusApi = {
  overview: (signal?: AbortSignal) =>
    requestJson<ServiceStatusOverviewDto>('/api/service-status', {
      signal,
      timeoutMs: 10_000,
    }),
};
