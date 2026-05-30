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
  sessionFile?: string;
  hasMappingFile: boolean;
  hasSessionFile: boolean;
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
    sessionFile,
    hasMappingFile: Boolean(mapped),
    hasSessionFile: Boolean(sessionFile && (await pathExists(sessionFile))),
  };
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
