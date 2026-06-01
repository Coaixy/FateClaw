import fs from 'node:fs/promises';
import path from 'node:path';

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
 * @remarks 这里必须和 agent-runner 的 session-manager 保持同一套命名规则。
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

/** 删除单个 Pi session 文件集合后的统计结果。 */
export interface PiSessionDeleteResult {
  sessionId: string;
  deletedMappingFile: boolean;
  deletedSessionFiles: number;
  missingSessionFile: boolean;
  skippedUnsafeSessionFiles: string[];
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
