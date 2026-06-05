import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveProjectRoot } from '../../infrastructure/project-root.js';

const PI_SESSION_DIR_ENV = 'FATECLAW_PI_SESSION_DIR';

function sanitizeSessionId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || 'default';
}

function resolvePiSessionDir(): string {
  const configured = process.env[PI_SESSION_DIR_ENV]?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(resolveProjectRoot(), '.fateclaw', 'pi-sessions');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
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
  piSessionId: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return [];
  }

  const suffix = `_${piSessionId}.jsonl`;
  return names
    .filter((name) => name === `${piSessionId}.jsonl` || name.endsWith(suffix))
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
}

/** conversation_logs 中保存的 Pi session 快照最小结构。 */
export interface PiSessionSnapshotArchiveSource {
  id?: unknown;
  provider?: unknown;
  model?: unknown;
  messages?: unknown;
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
): Promise<PiSessionFileState> {
  const sessionDir = resolvePiSessionDir();
  const piSessionId = sanitizeSessionId(sessionId);
  const mappingFile = path.join(sessionDir, `${piSessionId}.path`);
  let mapped = '';
  try {
    mapped = (await fs.readFile(mappingFile, 'utf-8')).trim();
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
    hasSessionFile: Boolean(sessionFile && (await pathExists(sessionFile))),
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
): PiSessionArchivePayload | null {
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.filter(isSnapshotMessage)
    : [];
  if (messages.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const piSessionId = sanitizeSessionId(sessionId);
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
): Promise<PiSessionArchiveReadResult> {
  const state = await readPiSessionFileState(sessionId);
  const candidates = new Set<string>();
  if (state.sessionFile) {
    candidates.add(state.sessionFile);
  }
  for (const matched of await listMatchingSessionFiles(
    state.sessionDir,
    sanitizeSessionId(sessionId),
  )) {
    candidates.add(matched);
  }

  const files: PiSessionArchivedFile[] = [];
  const skippedUnsafeSessionFiles: string[] = [];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!isPathInside(state.sessionDir, resolved)) {
      skippedUnsafeSessionFiles.push(resolved);
      continue;
    }

    try {
      const [content, stat] = await Promise.all([
        fs.readFile(resolved, 'utf-8'),
        fs.stat(resolved),
      ]);
      files.push({
        name: path.basename(resolved),
        content,
        size_bytes: Buffer.byteLength(content, 'utf-8'),
        modified_at: stat.mtime.toISOString(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const mappedFileName = state.sessionFile
    ? path.basename(state.sessionFile)
    : undefined;
  const archiveFileNames = new Set(files.map((file) => file.name));
  const mappingContent =
    mappedFileName && archiveFileNames.has(mappedFileName)
      ? mappedFileName
      : (files[0]?.name ?? null);

  return {
    sessionId,
    payload: {
      version: 1,
      mapping_file_name: path.basename(state.mappingFile),
      mapping_content: mappingContent,
      files,
      archived_at: new Date().toISOString(),
    },
    missingSessionFile:
      state.hasMappingFile && !state.hasSessionFile && files.length === 0,
    skippedUnsafeSessionFiles,
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
): Promise<{ writtenSessionFiles: number; writtenMappingFile: boolean }> {
  const sessionDir = resolvePiSessionDir();
  const piSessionId = sanitizeSessionId(sessionId);
  const mappingFile = path.join(sessionDir, `${piSessionId}.path`);
  await fs.mkdir(sessionDir, { recursive: true });

  let writtenSessionFiles = 0;
  for (const file of payload.files) {
    if (!isSafeArchiveFileName(file.name)) {
      continue;
    }
    await fs.writeFile(path.join(sessionDir, file.name), file.content, 'utf-8');
    writtenSessionFiles += 1;
  }

  const archivedFileNames = new Set(
    payload.files
      .map((file) => file.name)
      .filter((name) => isSafeArchiveFileName(name)),
  );
  const mappingContent = payload.mapping_content?.trim() || '';
  const safeMappingContent =
    mappingContent && archivedFileNames.has(mappingContent)
      ? mappingContent
      : (payload.files.find((file) => archivedFileNames.has(file.name))?.name ??
        '');

  if (!safeMappingContent) {
    return { writtenSessionFiles, writtenMappingFile: false };
  }

  await fs.writeFile(mappingFile, safeMappingContent, 'utf-8');
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
): Promise<PiSessionSnapshotArchiveWriteResult | null> {
  const payload = buildPiSessionArchivePayloadFromSnapshot(sessionId, snapshot);
  if (!payload) {
    return null;
  }
  const writeResult = await writePiSessionArchiveToFiles(sessionId, payload);
  return {
    payload,
    ...writeResult,
    snapshotMessageCount:
      payload.files.length > 0 ? snapshotMessageCount(snapshot) : 0,
  };
}

function snapshotMessageCount(snapshot: PiSessionSnapshotArchiveSource): number {
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
  return sessionId.startsWith('session-') ? sessionId : null;
}

function extractSessionIdFromJsonlFileName(name: string): string | null {
  if (!name.endsWith('.jsonl')) {
    return null;
  }
  const baseName = name.slice(0, -'.jsonl'.length);
  if (baseName.startsWith('session-')) {
    return baseName;
  }
  const marker = '_session-';
  const markerIndex = baseName.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  return baseName.slice(markerIndex + 1);
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
): Promise<PiSessionDeleteResult> {
  const state = await readPiSessionFileState(sessionId);
  const candidates = new Set<string>();
  if (state.sessionFile) {
    candidates.add(state.sessionFile);
  }
  for (const matched of await listMatchingSessionFiles(
    state.sessionDir,
    sanitizeSessionId(sessionId),
  )) {
    candidates.add(matched);
  }

  let deletedSessionFiles = 0;
  const skippedUnsafeSessionFiles: string[] = [];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!isPathInside(state.sessionDir, resolved)) {
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
  try {
    await fs.unlink(state.mappingFile);
    deletedMappingFile = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
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
    let mapped = '';
    try {
      mapped = (await fs.readFile(mappingPath, 'utf-8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    const mappedPath = mapped
      ? path.resolve(path.isAbsolute(mapped) ? mapped : path.join(sessionDir, mapped))
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

    if (await pathExists(mappedPath)) {
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
