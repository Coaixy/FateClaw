export type ServiceAvailabilityDto = 'operational' | 'unavailable' | 'unknown';

export interface ServiceStatusSampleDto {
  checked_at: string;
  status: ServiceAvailabilityDto;
  latency_ms: number | null;
}

export interface ServiceStatusOverviewDto {
  status: ServiceAvailabilityDto;
  checked_at: string | null;
  latency_ms: number | null;
  check_interval_seconds: number;
  stale_after_seconds: number;
  history: ServiceStatusSampleDto[];
}
