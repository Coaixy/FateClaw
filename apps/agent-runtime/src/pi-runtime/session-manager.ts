import fs from 'fs';
import path from 'path';

import { SessionManager } from '@earendil-works/pi-coding-agent';

const PI_SESSION_DIR_ENV = 'FATECLAW_PI_SESSION_DIR';

function sanitizeSessionId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || 'default';
}

export function resolvePiSessionDir(cwd: string): string {
  const configured = process.env[PI_SESSION_DIR_ENV]?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(cwd, '.fateclaw', 'pi-sessions');
}

export function resolvePiSessionFile(args: {
  cwd: string;
  sessionId: string;
}): {
  sessionDir: string;
  mappingFile: string;
  sessionFile?: string;
  piSessionId: string;
} {
  const sessionDir = resolvePiSessionDir(args.cwd);
  const piSessionId = sanitizeSessionId(args.sessionId);
  const mappingFile = path.join(sessionDir, `${piSessionId}.path`);
  let sessionFile: string | undefined;
  try {
    const mapped = fs.readFileSync(mappingFile, 'utf-8').trim();
    if (mapped) {
      sessionFile = path.isAbsolute(mapped)
        ? mapped
        : path.join(sessionDir, mapped);
    }
  } catch {
    sessionFile = undefined;
  }
  return {
    sessionDir,
    mappingFile,
    sessionFile,
    piSessionId,
  };
}

export function createFateClawPiSessionManager(args: {
  cwd: string;
  sessionId?: string;
}): {
  manager: SessionManager;
  sessionFile?: string;
  piSessionId?: string;
  persisted: boolean;
} {
  if (!args.sessionId?.trim()) {
    return {
      manager: SessionManager.create(args.cwd),
      persisted: true,
    };
  }

  const { sessionDir, mappingFile, sessionFile, piSessionId } = resolvePiSessionFile({
    cwd: args.cwd,
    sessionId: args.sessionId,
  });
  fs.mkdirSync(sessionDir, { recursive: true });

  if (sessionFile && fs.existsSync(sessionFile)) {
    const manager = SessionManager.open(sessionFile, sessionDir, args.cwd);
    return {
      manager,
      sessionFile,
      piSessionId,
      persisted: manager.isPersisted(),
    };
  }

  const manager = SessionManager.create(args.cwd, sessionDir);
  const createdFile = manager.newSession({ id: piSessionId });
  if (createdFile) {
    fs.writeFileSync(mappingFile, path.basename(createdFile), 'utf-8');
  }

  return {
    manager,
    sessionFile: createdFile,
    piSessionId,
    persisted: manager.isPersisted(),
  };
}

/**
 * 删除某个 Pi 会话的文件对(.path 映射 + 其指向的 .jsonl)。
 *
 * 供 workflow 隔离节点用:每个 AI 节点的 piSessionId 一次性、永不 reload,产出已落运行会话,
 * 跑完即删避免无限堆积(这类 `wf-…__pi` 命名不被按会话 id 的孤儿扫描识别)。删除失败静默忽略。
 *
 * @param args.cwd 运行目录。
 * @param args.sessionId 要删除的 Pi 会话标识(此处即 piSessionId)。
 */
export function deletePiSessionFiles(args: {
  cwd: string;
  sessionId: string;
}): void {
  try {
    const { mappingFile, sessionFile } = resolvePiSessionFile(args);
    if (sessionFile) fs.rmSync(sessionFile, { force: true });
    fs.rmSync(mappingFile, { force: true });
  } catch {
    // 清理失败不影响主流程:下次运行用新 piSessionId,旧文件最多残留。
  }
}
