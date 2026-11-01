import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { piSessionStorageKey } from '@fateclaw/contracts/agent/session';

import { resolveProjectRoot } from '#infrastructure/project-root';

const PI_SESSION_DIR_ENV = 'FATECLAW_PI_SESSION_DIR';

function normalizeContextGeneration(value: number | undefined): number {
  const generation = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Invalid Pi session context generation');
  }
  return generation;
}

function normalizeContextAudience(value: string | undefined): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 256) {
    throw new Error('Invalid Pi session context audience');
  }
  return value;
}

interface PiStorageContext {
  sessionId: string;
  storageId: string;
  generation: number;
  audienceHash: string | null;
}

function parseStorageSessionId(value: string): PiStorageContext | null {
  let sessionId = value;
  let generation = 0;
  const version = /^(.*)\.memory-([1-9]\d*)$/.exec(sessionId);
  if (version && Number.isSafeInteger(Number(version[2]))) {
    sessionId = version[1];
    generation = Number(version[2]);
  } else if (sessionId.includes('.memory-')) {
    return null;
  }
  let audienceHash: string | null = null;
  const audience = /^(.*)\.aud-([a-f0-9]{32})$/.exec(sessionId);
  if (audience) {
    sessionId = audience[1];
    audienceHash = audience[2];
  }
  if (
    !sessionId ||
    sessionId.includes('.aud-') ||
    sessionId.includes('.memory-')
  )
    return null;
  return { sessionId, storageId: value, generation, audienceHash };
}

function fileContext(
  name: string,
  sessionId: string,
  extension: '.path' | '.jsonl',
): PiStorageContext | null {
  if (!name.endsWith(extension)) return null;
  const businessId = piSessionStorageKey(sessionId);
  const base = name.slice(0, -extension.length);
  const markerIndex =
    extension === '.jsonl' ? base.lastIndexOf(`_${businessId}`) : -1;
  const storageId = markerIndex >= 0 ? base.slice(markerIndex + 1) : base;
  const parsed = parseStorageSessionId(storageId);
  return parsed?.sessionId === businessId ? parsed : null;
}

function fileMatchesContext(
  name: string,
  sessionId: string,
  storageId: string,
): boolean {
  const found = fileContext(name, sessionId, '.jsonl');
  if (found !== null) return found.storageId === storageId;
  // Legacy mappings may use a filename that predates the business-session suffix.
  return (
    storageId === piSessionStorageKey(sessionId) &&
    isSafeArchiveFileName(name) &&
    !name.includes('.aud-') &&
    !name.includes('.memory-') &&
    !extractSessionIdFromJsonlFileName(name)
  );
}

async function readMappingContent(mappingFile: string): Promise<string> {
  let handle;
  try {
    handle = await fs.open(
      mappingFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isFile()) return '';
    return (await handle.readFile('utf8')).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return '';
    throw error;
  } finally {
    await handle?.close();
  }
}

async function listSessionMappings(
  sessionDir: string,
  sessionId: string,
): Promise<Array<{ file: string; context: PiStorageContext }>> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => {
    const context = fileContext(name, sessionId, '.path');
    return context === null
      ? []
      : [{ file: path.join(sessionDir, name), context }];
  });
}

async function filesReferencedByOtherSessions(
  sessionDir: string,
  sessionId: string,
): Promise<Set<string>> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const referenced = new Set<string>();
  for (const name of names) {
    if (
      !name.endsWith('.path') ||
      fileContext(name, sessionId, '.path') !== null
    )
      continue;
    const content = await readMappingContent(path.join(sessionDir, name));
    if (content) referenced.add(path.resolve(sessionDir, content));
  }
  return referenced;
}

async function collectSessionFiles(
  state: PiSessionFileState,
  sessionId: string,
): Promise<{
  candidates: Set<string>;
  mappings: string[];
  contextMappings: Array<{ context: PiStorageContext; name: string }>;
}> {
  const mappings = await listSessionMappings(state.sessionDir, sessionId);
  const candidates = new Set<string>();
  const contextMappings: Array<{ context: PiStorageContext; name: string }> =
    [];
  for (const mapping of mappings) {
    const content = await readMappingContent(mapping.file);
    if (!content) continue;
    const mapped = path.resolve(state.sessionDir, content);
    if (!isPathInside(state.sessionDir, mapped)) {
      candidates.add(mapped);
    } else if (
      fileMatchesContext(
        path.basename(mapped),
        sessionId,
        mapping.context.storageId,
      )
    ) {
      candidates.add(mapped);
      contextMappings.push({
        context: mapping.context,
        name: path.basename(mapped),
      });
    }
  }
  for (const matched of await listMatchingSessionFiles(
    state.sessionDir,
    sessionId,
  ))
    candidates.add(matched);
  return {
    candidates,
    mappings: mappings.map((mapping) => mapping.file),
    contextMappings,
  };
}

function resolvePiSessionDir(): string {
  const configured = process.env[PI_SESSION_DIR_ENV]?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(resolveProjectRoot(), '.fateclaw', 'pi-sessions');
}

async function isRegularSessionFile(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isFile();
  } catch {
    return false;
  }
}

async function statFile(target: string): Promise<{
  size_bytes: number;
  modified_at: string | null;
} | null> {
  try {
    const stat = await fs.stat(target);
    return {
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isPathInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

async function listMatchingSessionFiles(
  sessionDir: string,
  sessionId: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return [];
  }

  return names
    .filter((name) => fileContext(name, sessionId, '.jsonl') !== null)
    .map((name) => path.join(sessionDir, name));
}

/** Pi session 映射文件和 jsonl 文件的存在状态。 */
export interface PiSessionFileState {
  sessionDir: string;
  mappingFile: string;
  mappingContent: string;
  sessionFile?: string;
  hasMappingFile: boolean;
  hasSessionFile: boolean;
}

/** 归档到数据库的单个 Pi session jsonl 文件。 */
export interface PiSessionArchivedFile {
  name: string;
  content: string;
  size_bytes: number;
  modified_at: string | null;
}

/** Pi session 文件归档负载，后续可从数据库回写到本地文件。 */
export interface PiSessionArchivePayload {
  version: 1;
  mapping_file_name: string;
  mapping_content: string | null;
  files: PiSessionArchivedFile[];
  archived_at: string;
  /** Missing metadata denotes the legacy generation zero. */
  context_generation?: number;
  contexts?: PiSessionArchiveContext[];
}

/** A context map contains only the opaque audience hash used in its storage key. */
export interface PiSessionArchiveContext {
  storage_id: string;
  context_generation: number;
  audience_hash?: string | null;
  mapping_file_name: string;
  mapping_content: string | null;
  file_names: string[];
}

/** conversation_logs 中保存的 Pi session 快照最小结构。 */
export interface PiSessionSnapshotArchiveSource {
  id?: unknown;
  provider?: unknown;
  model?: unknown;
  messages?: unknown;
  contextGeneration?: number;
  contextAudience?: string;
}

/** 由 Pi session snapshot 回写文件后的结果。 */
export interface PiSessionSnapshotArchiveWriteResult {
  payload: PiSessionArchivePayload;
  writtenSessionFiles: number;
  writtenMappingFile: boolean;
  snapshotMessageCount: number;
}

/**
 * 从 trace_events 中读取最近一次 Pi session 快照。
 *
 * @param traceEvents conversation_log_payloads.trace_events。
 * @returns 可用于重建 jsonl 的 Pi session snapshot；不存在时返回 null。
 */
export function readPiSessionSnapshotFromTraceEvents(
  traceEvents: unknown,
): PiSessionSnapshotArchiveSource | null {
  if (!Array.isArray(traceEvents)) {
    return null;
  }
  for (let index = traceEvents.length - 1; index >= 0; index -= 1) {
    const event = traceEvents[index];
    if (
      !event ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      (event as { type?: unknown }).type !== 'pi_session_snapshot'
    ) {
      continue;
    }
    const snapshot = (event as { session?: unknown }).session;
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      return snapshot as PiSessionSnapshotArchiveSource;
    }
  }
  return null;
}

/** 读取 Pi session 文件并整理成可落库的归档负载。 */
export interface PiSessionArchiveReadResult {
  sessionId: string;
  payload: PiSessionArchivePayload;
  missingSessionFile: boolean;
  skippedUnsafeSessionFiles: string[];
}

/**
 * 读取站内 AI Chat 对应的 Pi session 文件状态。
 *
 * @param sessionId - FateClaw chat_sessions.id。
 * @returns 当前映射文件和 jsonl 文件是否存在。
 * @remarks 这里必须和 agent-runtime 的 session-manager 保持同一套命名规则。
 */
export async function readPiSessionFileState(
  sessionId: string,
  contextGeneration?: number,
  contextAudience?: string,
): Promise<PiSessionFileState> {
  const sessionDir = resolvePiSessionDir();
  const generation = normalizeContextGeneration(contextGeneration);
  const piSessionId = piSessionStorageKey(
    sessionId,
    generation,
    normalizeContextAudience(contextAudience),
  );
  const mappingFile = path.join(sessionDir, `${piSessionId}.path`);
  let mapped = '';
  try {
    mapped = await readMappingContent(mappingFile);
  } catch {
    mapped = '';
  }

  const sessionFile = mapped
    ? path.isAbsolute(mapped)
      ? mapped
      : path.join(sessionDir, mapped)
    : undefined;

  return {
    sessionDir,
    mappingFile,
    mappingContent: mapped,
    sessionFile,
    hasMappingFile: Boolean(mapped),
    hasSessionFile: Boolean(
      sessionFile &&
      isPathInside(sessionDir, path.resolve(sessionFile)) &&
      fileMatchesContext(path.basename(sessionFile), sessionId, piSessionId) &&
      (await isRegularSessionFile(sessionFile)),
    ),
  };
}

function isSafeArchiveFileName(name: string): boolean {
  return (
    Boolean(name) &&
    path.basename(name) === name &&
    !path.isAbsolute(name) &&
    name.endsWith('.jsonl')
  );
}

function newArchiveContext(context: PiStorageContext): PiSessionArchiveContext {
  return {
    storage_id: context.storageId,
    context_generation: context.generation,
    audience_hash: context.audienceHash,
    mapping_file_name: `${context.storageId}.path`,
    mapping_content: null,
    file_names: [],
  };
}

function buildArchiveContexts(
  sessionId: string,
  files: PiSessionArchivedFile[],
  mappings: Array<{ context: PiStorageContext; name: string }>,
): PiSessionArchiveContext[] {
  const contexts = new Map<string, PiSessionArchiveContext>();
  const ensure = (context: PiStorageContext) => {
    const current =
      contexts.get(context.storageId) ?? newArchiveContext(context);
    contexts.set(context.storageId, current);
    return current;
  };
  for (const mapping of mappings) ensure(mapping.context);
  for (const file of files) {
    const context =
      fileContext(file.name, sessionId, '.jsonl') ??
      mappings.find((mapping) => mapping.name === file.name)?.context;
    if (context) ensure(context).file_names.push(file.name);
  }
  for (const context of contexts.values()) {
    const mapped = mappings.find(
      (mapping) => mapping.context.storageId === context.storage_id,
    )?.name;
    context.mapping_content =
      mapped && context.file_names.includes(mapped)
        ? mapped
        : (context.file_names[0] ?? null);
  }
  return [...contexts.values()];
}

function validateArchiveContext(
  value: unknown,
  sessionId: string,
): PiSessionArchiveContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as PiSessionArchiveContext;
  if (typeof candidate.storage_id !== 'string') return null;
  const parsed = parseStorageSessionId(candidate.storage_id);
  if (
    !parsed ||
    parsed.sessionId !== piSessionStorageKey(sessionId) ||
    candidate.context_generation !== parsed.generation ||
    (candidate.audience_hash ?? null) !== parsed.audienceHash ||
    candidate.mapping_file_name !== `${parsed.storageId}.path` ||
    (candidate.mapping_content !== null &&
      typeof candidate.mapping_content !== 'string') ||
    !Array.isArray(candidate.file_names) ||
    !candidate.file_names.every((name) => typeof name === 'string')
  )
    return null;
  return candidate;
}

function generateSessionEntryId(usedIds: Set<string>): string {
  for (let index = 0; index < 100; index += 1) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }

  const fallbackId = crypto.randomUUID();
  usedIds.add(fallbackId);
  return fallbackId;
}

function toIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  return fallback;
}

function isSnapshotMessage(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === 'string'
  );
}

function buildPiSessionArchivePayloadFromSnapshot(
  sessionId: string,
  snapshot: PiSessionSnapshotArchiveSource,
  generation: number,
  audience: string,
): PiSessionArchivePayload | null {
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.filter(isSnapshotMessage)
    : [];
  if (messages.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const piSessionId = piSessionStorageKey(sessionId, generation, audience);
  const fileName = `${now.replace(/[:.]/g, '-')}_${piSessionId}.jsonl`;
  const usedIds = new Set<string>();
  let parentId: string | null = null;
  const lines: unknown[] = [
    {
      type: 'session',
      version: 3,
      id: piSessionId,
      timestamp: now,
      cwd: resolveProjectRoot(),
    },
  ];

  if (
    typeof snapshot.provider === 'string' &&
    snapshot.provider.trim() &&
    typeof snapshot.model === 'string' &&
    snapshot.model.trim()
  ) {
    const id = generateSessionEntryId(usedIds);
    lines.push({
      type: 'model_change',
      id,
      parentId,
      timestamp: now,
      provider: snapshot.provider,
      modelId: snapshot.model,
    });
    parentId = id;
  }

  for (const message of messages) {
    const id = generateSessionEntryId(usedIds);
    const timestamp = toIsoTimestamp(message.timestamp, now);
    lines.push({
      type: 'message',
      id,
      parentId,
      timestamp,
      message,
    });
    parentId = id;
  }

  const content = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  return {
    version: 1,
    mapping_file_name: `${piSessionId}.path`,
    mapping_content: fileName,
    files: [
      {
        name: fileName,
        content,
        size_bytes: Buffer.byteLength(content, 'utf-8'),
        modified_at: now,
      },
    ],
    archived_at: now,
    ...(generation > 0 ? { context_generation: generation } : {}),
    contexts: [
      {
        ...newArchiveContext(parseStorageSessionId(piSessionId)!),
        mapping_content: fileName,
        file_names: [fileName],
      },
    ],
  };
}

/**
 * 读取某个 chat session 对应的 Pi session 文件内容。
 *
 * @param sessionId - FateClaw chat_sessions.id。
 * @returns 可直接存入 chat_sessions.pi_session_archive_payload 的 JSON 负载。
 * @remarks 只归档 session 目录内的 jsonl，避免被篡改的 .path 指向任意文件。
 */
export async function readPiSessionArchiveForSession(
  sessionId: string,
  contextGeneration?: number,
  contextAudience?: string,
): Promise<PiSessionArchiveReadResult> {
  const generation = normalizeContextGeneration(contextGeneration);
  const audience = normalizeContextAudience(contextAudience);
  const storageId = piSessionStorageKey(sessionId, generation, audience);
  const state = await readPiSessionFileState(sessionId, generation, audience);
  // Preserve every generation before business-session cleanup removes its files.
  const { candidates, contextMappings } = await collectSessionFiles(
    state,
    sessionId,
  );
  const otherSessionFiles = await filesReferencedByOtherSessions(
    state.sessionDir,
    sessionId,
  );

  const files: PiSessionArchivedFile[] = [];
  const skippedUnsafeSessionFiles: string[] = [];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (
      !isPathInside(state.sessionDir, resolved) ||
      otherSessionFiles.has(resolved)
    ) {
      skippedUnsafeSessionFiles.push(resolved);
      continue;
    }

    try {
      const handle = await fs.open(
        resolved,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          skippedUnsafeSessionFiles.push(resolved);
          continue;
        }
        const content = await handle.readFile('utf8');
        files.push({
          name: path.basename(resolved),
          content,
          size_bytes: Buffer.byteLength(content, 'utf-8'),
          modified_at: stat.mtime.toISOString(),
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        skippedUnsafeSessionFiles.push(resolved);
      } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const contexts = buildArchiveContexts(sessionId, files, contextMappings);
  const selectedContext = contexts.find(
    (context) => context.storage_id === storageId,
  );

  return {
    sessionId,
    payload: {
      version: 1,
      mapping_file_name: path.basename(state.mappingFile),
      mapping_content: selectedContext?.mapping_content ?? null,
      files,
      archived_at: new Date().toISOString(),
      ...(generation > 0 ? { context_generation: generation } : {}),
      contexts,
    },
    missingSessionFile:
      state.hasMappingFile &&
      !state.hasSessionFile &&
      !selectedContext?.file_names.length,
    skippedUnsafeSessionFiles,
  };
}

/** Re-archiving a partially restored session must retain the other archived audiences. */
export function mergePiSessionArchivePayload(
  sessionId: string,
  older: unknown,
  newer: unknown,
): unknown {
  const archive = (value: unknown): PiSessionArchivePayload | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const payload = value as PiSessionArchivePayload;
    return payload.version === 1 &&
      Array.isArray(payload.files) &&
      typeof payload.mapping_file_name === 'string'
      ? payload
      : null;
  };
  const previous = archive(older);
  const next = archive(newer);
  if (!previous || !next) return newer;
  const contexts = (
    payload: PiSessionArchivePayload,
  ): PiSessionArchiveContext[] => {
    if (Array.isArray(payload.contexts))
      return payload.contexts
        .map((entry) => validateArchiveContext(entry, sessionId))
        .filter((entry): entry is PiSessionArchiveContext => Boolean(entry));
    const ownerId = piSessionStorageKey(sessionId);
    if (
      payload.contexts !== undefined ||
      payload.mapping_file_name !== `${ownerId}.path` ||
      (payload.context_generation ?? 0) !== 0
    )
      return [];
    return [
      {
        ...newArchiveContext(parseStorageSessionId(ownerId)!),
        mapping_content: payload.mapping_content,
        file_names: payload.files.map((file) => file.name),
      },
    ];
  };
  const mergedContexts = new Map(
    contexts(previous).map((context) => [context.storage_id, context]),
  );
  for (const context of contexts(next))
    if (context.file_names.length || !mergedContexts.has(context.storage_id))
      mergedContexts.set(context.storage_id, context);
  const files = new Map<string, PiSessionArchivedFile>();
  for (const file of [...previous.files, ...next.files])
    if (
      file &&
      isSafeArchiveFileName(file.name) &&
      typeof file.content === 'string'
    )
      files.set(file.name, file);
  return {
    ...next,
    contexts: [...mergedContexts.values()],
    files: [...files.values()],
  };
}

/**
 * 将数据库中的 Pi session 归档负载回写成本地 jsonl/path 文件。
 *
 * @param sessionId - FateClaw chat_sessions.id。
 * @param payload - chat_sessions.pi_session_archive_payload 中保存的负载。
 * @returns 实际写入的 jsonl/path 数量。
 * @remarks 该函数只接受安全 basename，避免归档数据写出 session 目录。
 */
export async function writePiSessionArchiveToFiles(
  sessionId: string,
  payload: PiSessionArchivePayload,
  contextGeneration?: number,
  contextAudience?: string,
): Promise<{ writtenSessionFiles: number; writtenMappingFile: boolean }> {
  const generation = normalizeContextGeneration(
    contextGeneration ?? payload.context_generation,
  );
  const audience = normalizeContextAudience(contextAudience);
  const piSessionId = piSessionStorageKey(sessionId, generation, audience);
  const missing = { writtenSessionFiles: 0, writtenMappingFile: false };
  let selected: PiSessionArchiveContext;
  if (payload.contexts === undefined) {
    // Archives predating context maps can prove only owner generation-zero history.
    if (
      audience ||
      generation !== 0 ||
      normalizeContextGeneration(payload.context_generation) !== 0
    )
      return missing;
    if (payload.mapping_file_name !== `${piSessionId}.path`)
      throw new Error(
        'Pi session archive mapping does not match its session context',
      );
    selected = {
      ...newArchiveContext(parseStorageSessionId(piSessionId)!),
      mapping_content: payload.mapping_content,
      file_names: payload.files.map((file) => file.name),
    };
  } else {
    if (!Array.isArray(payload.contexts)) return missing;
    const matches = payload.contexts
      .map((entry) => validateArchiveContext(entry, sessionId))
      .filter((entry): entry is PiSessionArchiveContext =>
        Boolean(entry && entry.storage_id === piSessionId),
      );
    if (matches.length !== 1) return missing;
    selected = matches[0];
  }
  const allowedNames = new Set(
    selected.file_names.filter(
      (name) =>
        isSafeArchiveFileName(name) &&
        fileMatchesContext(name, sessionId, piSessionId) &&
        (fileContext(name, sessionId, '.jsonl') !== null ||
          name === selected.mapping_content?.trim()),
    ),
  );
  if (!allowedNames.size) return missing;
  const sessionDir = resolvePiSessionDir();
  const mappingFile = path.join(sessionDir, `${piSessionId}.path`);
  await fs.mkdir(sessionDir, { recursive: true });
  const otherSessionFiles = await filesReferencedByOtherSessions(
    sessionDir,
    sessionId,
  );

  let writtenSessionFiles = 0;
  const writtenFileNames = new Set<string>();
  // Retained history from another audience or generation must never re-enter this context.
  for (const file of payload.files) {
    const knownOwner = extractSessionIdFromJsonlFileName(file.name);
    const target = path.join(sessionDir, file.name);
    if (
      !allowedNames.has(file.name) ||
      (knownOwner && knownOwner !== piSessionStorageKey(sessionId)) ||
      otherSessionFiles.has(target)
    ) {
      continue;
    }
    await fs.writeFile(target, file.content, {
      encoding: 'utf-8',
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
    });
    writtenSessionFiles += 1;
    writtenFileNames.add(file.name);
  }

  const mappingContent = selected.mapping_content?.trim() || '';
  const safeMappingContent =
    mappingContent && writtenFileNames.has(mappingContent)
      ? mappingContent
      : ([...writtenFileNames][0] ?? '');

  if (!safeMappingContent) {
    return { writtenSessionFiles, writtenMappingFile: false };
  }

  await fs.writeFile(mappingFile, safeMappingContent, {
    encoding: 'utf-8',
    flag:
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
  });
  return { writtenSessionFiles, writtenMappingFile: true };
}

/**
 * 将 conversation_logs 中的 Pi session snapshot 回写为本地 jsonl/path 文件。
 *
 * @param sessionId - FateClaw chat_sessions.id。
 * @param snapshot - conversation_log_payloads.trace_events 中的 pi_session_snapshot.session。
 * @returns 回写结果和可持久化到 chat_sessions.pi_session_archive_payload 的归档负载。
 * @remarks 这是历史数据兜底：snapshot 不是原始 jsonl，但 messages 可重建 Pi 能继续读取的线性会话。
 */
export async function writePiSessionSnapshotArchiveToFiles(
  sessionId: string,
  snapshot: PiSessionSnapshotArchiveSource,
  contextGeneration?: number,
  contextAudience?: string,
): Promise<PiSessionSnapshotArchiveWriteResult | null> {
  const snapshotGeneration = normalizeContextGeneration(
    snapshot.contextGeneration,
  );
  const generation = normalizeContextGeneration(
    contextGeneration ?? snapshotGeneration,
  );
  if (generation !== snapshotGeneration)
    throw new Error('Pi session snapshot context generation mismatch');
  const snapshotAudience = normalizeContextAudience(snapshot.contextAudience);
  const audience = normalizeContextAudience(
    contextAudience ?? snapshotAudience,
  );
  if (audience !== snapshotAudience)
    throw new Error('Pi session snapshot context audience mismatch');
  const payload = buildPiSessionArchivePayloadFromSnapshot(
    sessionId,
    snapshot,
    generation,
    audience,
  );
  if (!payload) {
    return null;
  }
  const writeResult = await writePiSessionArchiveToFiles(
    sessionId,
    payload,
    generation,
    audience,
  );
  const archive = await readPiSessionArchiveForSession(
    sessionId,
    generation,
    audience,
  );
  return {
    payload: archive.payload,
    ...writeResult,
    snapshotMessageCount:
      payload.files.length > 0 ? snapshotMessageCount(snapshot) : 0,
  };
}

function snapshotMessageCount(
  snapshot: PiSessionSnapshotArchiveSource,
): number {
  return Array.isArray(snapshot.messages)
    ? snapshot.messages.filter(isSnapshotMessage).length
    : 0;
}

/** 删除单个 Pi session 文件集合后的统计结果。 */
export interface PiSessionDeleteResult {
  sessionId: string;
  deletedMappingFile: boolean;
  deletedSessionFiles: number;
  missingSessionFile: boolean;
  skippedUnsafeSessionFiles: string[];
}

export type PiSessionOrphanFileKind = 'dangling_path' | 'unmapped_jsonl';

/** Pi session 孤儿文件候选。 */
export interface PiSessionOrphanFileEntry {
  kind: PiSessionOrphanFileKind;
  name: string;
  path: string;
  session_id: string | null;
  size_bytes: number | null;
  modified_at: string | null;
}

/** Pi session 文件系统孤儿扫描结果。 */
export interface PiSessionOrphanFileScanResult {
  session_dir: string;
  total_files: number;
  scanned_files: number;
  truncated: boolean;
  scanned_path_files: number;
  scanned_jsonl_files: number;
  dangling_path_files: PiSessionOrphanFileEntry[];
  unmapped_jsonl_files: PiSessionOrphanFileEntry[];
  unknown_files: string[];
  unsafe_path_files: string[];
}

/** Pi session 孤儿文件物理删除结果。 */
export interface PiSessionOrphanFileDeleteResult {
  deleted_path_files: number;
  deleted_jsonl_files: number;
  skipped_unsafe_files: string[];
}

function extractSessionIdFromPathFileName(name: string): string | null {
  if (!name.endsWith('.path')) {
    return null;
  }
  const sessionId = name.slice(0, -'.path'.length);
  return sessionId.startsWith('session-')
    ? (parseStorageSessionId(sessionId)?.sessionId ?? null)
    : null;
}

function extractSessionIdFromJsonlFileName(name: string): string | null {
  if (!name.endsWith('.jsonl')) {
    return null;
  }
  const baseName = name.slice(0, -'.jsonl'.length);
  if (baseName.startsWith('session-')) {
    return parseStorageSessionId(baseName)?.sessionId ?? null;
  }
  const marker = '_session-';
  const markerIndex = baseName.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  return (
    parseStorageSessionId(baseName.slice(markerIndex + 1))?.sessionId ?? null
  );
}

/**
 * 删除某个 chat session 对应的 Pi session 文件。
 *
 * @param sessionId - FateClaw chat_sessions.id。
 * @returns 删除数量与异常跳过信息。
 * @remarks 只删除 session 目录内的文件，避免被篡改的 .path 指向任意路径。
 */
export async function deletePiSessionFilesForSession(
  sessionId: string,
  contextGeneration?: number,
  contextAudience?: string,
): Promise<PiSessionDeleteResult> {
  const state = await readPiSessionFileState(
    sessionId,
    contextGeneration,
    contextAudience,
  );
  const { candidates, mappings } = await collectSessionFiles(state, sessionId);
  const otherSessionFiles = await filesReferencedByOtherSessions(
    state.sessionDir,
    sessionId,
  );

  let deletedSessionFiles = 0;
  const skippedUnsafeSessionFiles: string[] = [];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (
      !isPathInside(state.sessionDir, resolved) ||
      otherSessionFiles.has(resolved)
    ) {
      skippedUnsafeSessionFiles.push(resolved);
      continue;
    }
    try {
      await fs.unlink(resolved);
      deletedSessionFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  let deletedMappingFile = false;
  for (const mappingFile of mappings) {
    try {
      await fs.unlink(mappingFile);
      deletedMappingFile = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return {
    sessionId,
    deletedMappingFile,
    deletedSessionFiles,
    missingSessionFile:
      state.hasMappingFile &&
      !state.hasSessionFile &&
      deletedSessionFiles === 0,
    skippedUnsafeSessionFiles,
  };
}

/**
 * 扫描 Pi session 目录中的孤儿文件候选。
 *
 * @param input - 单轮最多扫描的目录项数量。
 * @returns 文件系统分类结果；该函数只读文件，不做物理删除。
 * @remarks 只有保守识别为 FateClaw chat session 的文件才带 session_id。
 */
export async function scanPiSessionOrphanFiles(input?: {
  limit?: number;
}): Promise<PiSessionOrphanFileScanResult> {
  const sessionDir = resolvePiSessionDir();
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        session_dir: sessionDir,
        total_files: 0,
        scanned_files: 0,
        truncated: false,
        scanned_path_files: 0,
        scanned_jsonl_files: 0,
        dangling_path_files: [],
        unmapped_jsonl_files: [],
        unknown_files: [],
        unsafe_path_files: [],
      };
    }
    throw error;
  }

  const limit = Math.min(Math.max(input?.limit ?? 5000, 1), 50_000);
  const scannedNames = [...names].sort().slice(0, limit);
  const referencedJsonlNames = new Set<string>();
  const danglingPathFiles: PiSessionOrphanFileEntry[] = [];
  const unmappedJsonlFiles: PiSessionOrphanFileEntry[] = [];
  const unknownFiles: string[] = [];
  const unsafePathFiles: string[] = [];
  let scannedPathFiles = 0;
  let scannedJsonlFiles = 0;

  for (const name of scannedNames) {
    if (!name.endsWith('.path')) {
      continue;
    }
    scannedPathFiles += 1;
    const mappingPath = path.join(sessionDir, name);
    const mappingStat = await statFile(mappingPath);
    const mapped = await readMappingContent(mappingPath);
    if (!mapped && !mappingStat) continue;

    const mappedPath = mapped
      ? path.resolve(
          path.isAbsolute(mapped) ? mapped : path.join(sessionDir, mapped),
        )
      : null;
    if (!mappedPath || !isPathInside(sessionDir, mappedPath)) {
      if (mappedPath) {
        unsafePathFiles.push(name);
        continue;
      }
      danglingPathFiles.push({
        kind: 'dangling_path',
        name,
        path: mappingPath,
        session_id: extractSessionIdFromPathFileName(name),
        size_bytes: mappingStat?.size_bytes ?? null,
        modified_at: mappingStat?.modified_at ?? null,
      });
      continue;
    }

    const storageId = name.slice(0, -'.path'.length);
    if (storageId.startsWith('session-')) {
      const context = parseStorageSessionId(storageId);
      if (
        !context ||
        !fileMatchesContext(
          path.basename(mappedPath),
          context.sessionId,
          context.storageId,
        )
      ) {
        unsafePathFiles.push(name);
        continue;
      }
    }

    if (await isRegularSessionFile(mappedPath)) {
      referencedJsonlNames.add(path.basename(mappedPath));
      continue;
    }

    danglingPathFiles.push({
      kind: 'dangling_path',
      name,
      path: mappingPath,
      session_id: extractSessionIdFromPathFileName(name),
      size_bytes: mappingStat?.size_bytes ?? null,
      modified_at: mappingStat?.modified_at ?? null,
    });
  }

  for (const name of scannedNames) {
    const filePath = path.join(sessionDir, name);
    if (name.endsWith('.path')) {
      continue;
    }
    if (!name.endsWith('.jsonl')) {
      unknownFiles.push(name);
      continue;
    }
    scannedJsonlFiles += 1;
    if (referencedJsonlNames.has(name)) {
      continue;
    }
    const fileStat = await statFile(filePath);
    unmappedJsonlFiles.push({
      kind: 'unmapped_jsonl',
      name,
      path: filePath,
      session_id: extractSessionIdFromJsonlFileName(name),
      size_bytes: fileStat?.size_bytes ?? null,
      modified_at: fileStat?.modified_at ?? null,
    });
  }

  return {
    session_dir: sessionDir,
    total_files: names.length,
    scanned_files: scannedNames.length,
    truncated: names.length > scannedNames.length,
    scanned_path_files: scannedPathFiles,
    scanned_jsonl_files: scannedJsonlFiles,
    dangling_path_files: danglingPathFiles,
    unmapped_jsonl_files: unmappedJsonlFiles,
    unknown_files: unknownFiles,
    unsafe_path_files: unsafePathFiles,
  };
}

/**
 * 删除经过 admin 服务判定为安全的 Pi session 孤儿文件。
 *
 * @param entries - 待删除的孤儿文件候选。
 * @returns 实际删除数量和二次路径校验跳过列表。
 * @remarks 调用方负责判定 DB 归档状态；这里负责最后的路径安全边界。
 */
export async function deletePiSessionOrphanFiles(
  entries: PiSessionOrphanFileEntry[],
): Promise<PiSessionOrphanFileDeleteResult> {
  const sessionDir = resolvePiSessionDir();
  let deletedPathFiles = 0;
  let deletedJsonlFiles = 0;
  const skippedUnsafeFiles: string[] = [];

  for (const entry of entries) {
    const resolved = path.resolve(entry.path);
    if (!isPathInside(sessionDir, resolved)) {
      skippedUnsafeFiles.push(entry.path);
      continue;
    }

    try {
      await fs.unlink(resolved);
      if (entry.kind === 'dangling_path') {
        deletedPathFiles += 1;
      } else {
        deletedJsonlFiles += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return {
    deleted_path_files: deletedPathFiles,
    deleted_jsonl_files: deletedJsonlFiles,
    skipped_unsafe_files: skippedUnsafeFiles,
  };
}
