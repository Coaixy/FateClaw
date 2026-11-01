import { createHash } from 'node:crypto';
import type {
  MemoryKind,
  MemoryRequestScope,
} from '@fateclaw/contracts/memory';

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'MEMORY.INVALID',
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

export interface MemoryScopeRow {
  id: string;
  owner_user_id: string;
  parent_scope_id: string | null;
  actor_key: string;
  audience_key: string;
  bound_subject_id?: string | null;
  share_subject_memory?: boolean;
  binding_revision?: number;
  display_name?: string | null;
  epoch: number;
  revision: number;
  learning_enabled: boolean;
  recall_enabled: boolean;
  chat_editing_enabled: boolean;
  cleared_at?: Date | string | null;
}

export interface MemorySourceRow {
  id: string;
  owner_user_id: string;
  scope_id: string;
  subject_id: string;
  memory_space_id?: string | null;
  source_kind: 'message' | 'profile' | 'manual';
  source_role: 'user' | 'assistant' | 'profile' | 'manual';
  source_ref: string;
  account_id: string | null;
  message_id: string | null;
  session_id: string | null;
  revision: number;
  content_hash: string;
  source_sequence: string | number;
  observed_at: Date | string;
  epoch: number;
  learning_enabled: boolean;
  excluded_at: Date | string | null;
  identity_snapshot?: MemoryRequestScope;
  extracted_revision: number;
}

export interface MemoryItemRow {
  id: string;
  family_id: string;
  owner_user_id: string;
  scope_id: string;
  subject_id: string;
  kind: MemoryKind;
  assertion_type: 'stated' | 'experience' | 'plan' | 'inferred';
  content: string;
  content_hash: string;
  fact_key: string | null;
  status: 'active' | 'superseded' | 'disputed' | 'forgotten';
  origin: 'automatic' | 'explicit' | 'manual';
  revision: number;
  epoch: number;
  source_sequence: string | number;
  observed_at: Date | string;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  supersedes_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface MemoryJobRow {
  id: string;
  owner_user_id: string;
  scope_id: string;
  subject_id: string | null;
  source_id: string | null;
  source_revision: number | null;
  request_id: string | null;
  kind: 'extract' | 'backfill';
  event_type: string;
  epoch: number;
  state:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'cancelled'
    | 'paused';
  payload: Record<string, unknown>;
  attempts: number;
  lease_token: string | null;
  lease_until: Date | string | null;
  processed_count: number;
  total_count: number | null;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function memoryHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function memoryContentHash(
  kind: MemoryKind,
  content: string,
  key?: string | null,
): string {
  return memoryHash(
    `${kind}\0${key ?? ''}\0${content.normalize('NFKC').trim().replace(/\s+/g, ' ')}`,
  );
}

export function memorySourceId(
  scopeId: string,
  sourceRef: string,
  hash: string,
): string {
  return memoryHash(`${scopeId}\0${sourceRef}\0${hash}`);
}

export function isoDate(value: Date | string): string {
  return new Date(value).toISOString();
}

export function assertMemoryScopeCurrent(
  snapshot: MemoryRequestScope,
  current: MemoryScopeRow,
  usage: 'read' | 'learn' | 'edit',
): void {
  if (
    snapshot.ownerUserId !== current.owner_user_id ||
    snapshot.epoch !== current.epoch
  )
    throw new MemoryError(
      '记忆设置已变化，请重新发送消息',
      409,
      'MEMORY.REVOKED',
    );
  if (usage === 'read' && (!current.recall_enabled || !snapshot.recallEnabled))
    throw new MemoryError(
      '当前已停止使用历史记忆',
      409,
      'MEMORY.RECALL_DISABLED',
    );
  if (
    usage === 'learn' &&
    (!current.learning_enabled || !snapshot.learningEnabled)
  )
    throw new MemoryError(
      '当前已停止自动学习记忆',
      409,
      'MEMORY.LEARNING_DISABLED',
    );
  if (
    usage === 'edit' &&
    (!current.chat_editing_enabled || !snapshot.chatEditingEnabled)
  )
    throw new MemoryError(
      '当前已关闭通过对话编辑记忆',
      403,
      'MEMORY.EDIT_DISABLED',
    );
}

/**
 * Single characters match nearly every row, so they are used only when the query has no longer
 * term. Han runs also contribute every bigram, because the segmenter splits words such as "考研"
 * into "考/研".
 */
export function memoryQueryTerms(query: string): string[] {
  const text = query.normalize('NFKC').toLowerCase().slice(0, 2000);
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const terms = new Set<string>();
  const singles = new Set<string>();
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue;
    const word = part.segment.trim();
    if (word.length >= 2) terms.add(word);
    else if (/[\d\p{Script=Han}]/u.test(word)) singles.add(word);
  }
  for (const [run] of text.matchAll(/\p{Script=Han}{3,}/gu))
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  const meaningful = (values: Set<string>) =>
    [...values].filter((term) => !MEMORY_STOP_TERMS.has(term));
  const long = meaningful(terms);
  return (long.length ? long : meaningful(singles)).slice(0, 24);
}

const MEMORY_STOP_TERMS = new Set([
  '什么',
  '怎么',
  '哪里',
  '一下',
  '那个',
  '这个',
  '之前',
  '我们',
  '现在',
  '我',
  '你',
  '他',
  '她',
  '它',
  '在',
  '是',
  '有',
  '和',
  '与',
  '把',
  '被',
  '对',
  '给',
  '想',
  '要',
  '也',
  '都',
  '这',
  '那',
  '还',
  '很',
  '的',
  '地',
  '得',
  '了',
  '吗',
  '吧',
]);

export function memoryLexicalScore(
  content: string,
  query: string,
  terms: string[],
): number {
  const text = content.normalize('NFKC').toLowerCase();
  const exact =
    query.trim().length >= 2 && text.includes(query.trim().toLowerCase())
      ? 4
      : 0;
  return (
    exact +
    terms.reduce(
      (score, term) =>
        score + (text.includes(term) ? 1 + Math.min(term.length, 8) / 8 : 0),
      0,
    )
  );
}

const GREETING =
  /^(?:你好|您好|在吗|在不在|嗨|哈喽|早上好|晚上好|谢谢|多谢|感谢|好的|好|嗯嗯|嗯|哦|噢|收到|ok|okay|hi|hello|thanks|thank you)$/i;

/**
 * Skips the model call for messages that cannot carry a durable statement. Short answers such as
 * "男" or "1990年" are kept: they answer intake questions.
 */
export function memorySourceHasNoStatement(content: string): boolean {
  const text = content.normalize('NFKC').trim();
  const words = text.replace(/[\p{P}\p{S}\s]/gu, '');
  if (!words) return true;
  if (GREETING.test(words)) return true;
  // A single question without a first-person clause asks rather than tells.
  return (
    /[?？]$/.test(text) &&
    !/[。！!；;\n]/.test(text) &&
    !/(?:我|本人|\bI\b|\bmy\b|\bme\b)/i.test(text)
  );
}

export function escapeMemoryLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function validateMemoryContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim() || content.length > 12_000)
    throw new MemoryError('记忆内容不能为空，且不能超过 12000 字符');
  return content.trim();
}
