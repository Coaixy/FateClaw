export const MAX_MEMORY_QUERY_CHARS = 2_000;
export const MAX_MEMORY_HYDRATE_REFERENCES = 100;
export const MAX_MEMORY_CONTENT_CHARS = 12_000;
export const MAX_MEMORY_SOURCE_PAGE_CHARS = 50_000;
export const MEMORY_POLICY_INTEGER_MAX = 1_000_000_000;
export type MemoryKind = 'fact' | 'preference' | 'event' | 'plan' | 'decision';
export type MemoryItemStatus =
  | 'active'
  | 'superseded'
  | 'disputed'
  | 'forgotten';
export type MemoryReferenceKind = 'item' | 'source';

export interface MemoryReference {
  kind: MemoryReferenceKind;
  id: string;
  revision: number;
  score?: number;
  offset?: number;
  limit?: number;
}

/** Bound by the host at admission; model arguments cannot change identity. */
export interface MemoryRequestScope {
  scopeId: string;
  ownerUserId: string;
  actorKey: string;
  audienceKey: string;
  subjectId: string;
  epoch: number;
  learningEnabled: boolean;
  recallEnabled: boolean;
  chatEditingEnabled: boolean;
  contextGeneration: number;
  contextAudience?: string;
  memorySpaceId?: string;
  speakerSubjectId?: string;
  bindingRevision?: number;
  ownerMemoryAccess?: boolean;
  /** The actual speaker is the account owner (web, or a WeChat sender bound to the owner with sharing). */
  ownerAudience?: boolean;
}

export interface MemorySettingsDto {
  learning_enabled: boolean;
  recall_enabled: boolean;
  chat_editing_enabled: boolean;
  revision: number;
  epoch: number;
}

export interface MemorySubjectDto {
  id: string;
  kind: 'self' | 'client' | 'sender' | 'unresolved';
  name: string;
}

export interface MemoryScopeDto {
  id: string;
  channel: 'web' | 'wechat';
  display_name: string;
  speaker_subject_id: string | null;
  share_subject_memory: boolean;
  binding_revision: number;
}

export interface MemoryItemDto {
  scope_id?: string;
  scope_name?: string;
  id: string;
  subject_id: string;
  subject_name: string;
  kind: MemoryKind;
  content: string;
  fact_key: string | null;
  status: MemoryItemStatus;
  origin: 'automatic' | 'explicit' | 'manual';
  revision: number;
  observed_at: string;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
  evidence_count: number;
}

export interface MemoryEvidenceDto {
  source_revision?: number;
  scope_id?: string;
  scope_name?: string;
  id: string;
  source_id: string;
  session_id: string | null;
  message_id: string | null;
  source_role: 'user' | 'assistant' | 'profile' | 'manual';
  quote: string;
  observed_at: string;
  source_available: boolean;
}

export interface MemoryListDto {
  items: MemoryItemDto[];
  subjects: MemorySubjectDto[];
  next_cursor: string | null;
  settings: MemorySettingsDto;
}

export interface MemoryJobDto {
  id: string;
  kind: 'extract' | 'backfill';
  state:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'cancelled'
    | 'paused';
  attempts: number;
  processed_count: number;
  total_count: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySessionSettingsDto {
  id: string;
  title: string;
  learning_enabled: boolean;
  revision: number;
}

export interface MemoryStatusDto {
  pending_jobs: number;
  failed_jobs: number;
  active_items: number;
  indexed_items: number;
  recent_jobs: MemoryJobDto[];
}

export interface MemoryRuntimePolicy {
  enabled: boolean;
  extraction_model_id: string | null;
  default_learning_enabled: boolean;
  worker_concurrency: number;
  job_timeout_ms: number;
  max_attempts: number;
  extraction_input_tokens: number;
  extraction_output_tokens: number;
  recall_token_budget: number;
  recall_max_results: number;
  recall_timeout_ms: number;
  recent_source_limit: number;
  daily_token_budget: number;
  backfill_batch_size: number;
  revision: number;
}

export const DEFAULT_MEMORY_RUNTIME_POLICY: MemoryRuntimePolicy = {
  enabled: true,
  extraction_model_id: null,
  default_learning_enabled: true,
  worker_concurrency: 2,
  job_timeout_ms: 45_000,
  max_attempts: 3,
  extraction_input_tokens: 8_000,
  extraction_output_tokens: 2_000,
  recall_token_budget: 6_000,
  recall_max_results: 12,
  recall_timeout_ms: 2_000,
  recent_source_limit: 6,
  daily_token_budget: 1_000_000,
  backfill_batch_size: 40,
  revision: 1,
};

export interface MemoryRuntimeStatusDto extends MemoryStatusDto {
  model_choices: Array<{
    id: string;
    display_name: string;
    model_name: string;
  }>;
  policy: MemoryRuntimePolicy;
  usage_today: Array<{
    purpose: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

export interface MemoryExcerpt {
  reference: MemoryReference;
  text: string;
  label: string;
  observedAt?: string;
  sourceMessageId?: string;
  sourceSessionId?: string;
  sourceReferences?: MemoryReference[];
  nextReference?: MemoryReference;
  /** Selected by the host (core facts, recent sources, recall) rather than requested by reference. */
  automatic?: boolean;
}

/**
 * A tokenizer-independent estimate: one token per non-ASCII (mostly CJK) character, which common
 * tokenizers do not exceed, and one per three ASCII characters. Billing settles on reported usage;
 * this only sizes reservations and context budgets. UTF-8 bytes overstated CJK about threefold.
 */
export function estimateMemoryTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii++;
    else other++;
  }
  return other + Math.ceil(ascii / 3);
}

export interface MemoryHydration {
  status: 'ready' | 'partial' | 'disabled' | 'unavailable';
  epoch: number;
  contextGeneration: number;
  contextAudience?: string;
  tokenBudget: number;
  excerpts: MemoryExcerpt[];
}
