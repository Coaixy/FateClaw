export type ServiceAvailabilityDto = 'operational' | 'unavailable' | 'unknown';

export interface ServiceStatusSampleDto {
  checked_at: string;
  status: ServiceAvailabilityDto;
  latency_ms: number | null;
}

export interface ServiceStatusDetailsDto {
  status: ServiceAvailabilityDto;
  checked_at: string | null;
  latency_ms: number | null;
  check_interval_seconds: number;
  stale_after_seconds: number;
  history: ServiceStatusSampleDto[];
}

export interface ServiceStatusServiceDto extends ServiceStatusDetailsDto {
  pool_key: 'official' | 'benefit';
  display_name: string;
  supply?: import('../model-settings/index.js').BenefitSupplyState;
  supply_checked_at?: string;
}

export interface ServiceStatusOverviewDto extends ServiceStatusDetailsDto {
  services?: ServiceStatusServiceDto[];
}
