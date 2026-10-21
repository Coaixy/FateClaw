export const RUNTIME_CONFIG_LIMITS = {
  agent_concurrency_limit: { min: 1, max: 1000 },
  agent_account_concurrency: { min: 1, max: 100 },
  local_agent_max_processes: { min: 1, max: 100 },
  local_agent_idle_ttl_ms: { min: 30_000, max: 86_400_000 },
  pi_session_inactive_cleanup_days: { min: 1, max: 3650 },
  pi_session_orphan_grace_days: { min: 1, max: 3650 },
  skill_bundle_max_files: { min: 1, max: 500 },
  skill_bundle_max_file_chars: { min: 1, max: 2_000_000 },
  skill_bundle_max_total_chars: { min: 1, max: 10_000_000 },
  skill_bundle_max_zip_bytes: { min: 1024, max: 104_857_600 },
  user_skill_max_count: { min: 1, max: 500 },
} as const;

export type RuntimeConfigValues = {
  [K in keyof typeof RUNTIME_CONFIG_LIMITS]: number;
} & {
  pi_session_health_enabled: boolean;
  wechat_claw_enabled: boolean;
};

export interface RuntimeConfigDto extends RuntimeConfigValues {
  revision: number;
  updated_at: string;
}

export type RuntimeConfigUpdateDto = RuntimeConfigValues & { revision: number };
