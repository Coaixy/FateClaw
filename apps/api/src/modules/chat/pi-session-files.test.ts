import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deletePiSessionOrphanFiles,
  scanPiSessionOrphanFiles,
} from './pi-session-files.js';

const PI_SESSION_DIR_ENV = 'FATECLAW_PI_SESSION_DIR';

let tempDir: string | null = null;
let previousPiSessionDir: string | undefined;

async function writeFile(name: string, content: string): Promise<void> {
  if (!tempDir) {
    throw new Error('测试目录尚未初始化');
  }
  await fs.writeFile(path.join(tempDir, name), content, 'utf-8');
}

describe('Pi session orphan files', () => {
  beforeEach(async () => {
    previousPiSessionDir = process.env[PI_SESSION_DIR_ENV];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sessions-'));
    process.env[PI_SESSION_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    if (previousPiSessionDir === undefined) {
      delete process.env[PI_SESSION_DIR_ENV];
    } else {
      process.env[PI_SESSION_DIR_ENV] = previousPiSessionDir;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('classifies orphan files without touching referenced jsonl files', async () => {
    await writeFile('session-active.path', 'active.jsonl');
    await writeFile('active.jsonl', '{"type":"session"}\n');
    await writeFile('session-missing.path', 'missing.jsonl');
    await writeFile('2000_session-archived.jsonl', '{"type":"session"}\n');
    await writeFile('session-unsafe.path', '../secret.jsonl');
    await writeFile('notes.txt', 'note');

    await expect(scanPiSessionOrphanFiles()).resolves.toMatchObject({
      scanned_path_files: 3,
      scanned_jsonl_files: 2,
      dangling_path_files: [
        expect.objectContaining({
          name: 'session-missing.path',
          session_id: 'session-missing',
        }),
      ],
      unmapped_jsonl_files: [
        expect.objectContaining({
          name: '2000_session-archived.jsonl',
          session_id: 'session-archived',
        }),
      ],
      unknown_files: ['notes.txt'],
      unsafe_path_files: ['session-unsafe.path'],
    });
  });

  it('deletes only selected orphan file entries', async () => {
    await writeFile('session-active.path', 'active.jsonl');
    await writeFile('active.jsonl', '{"type":"session"}\n');
    await writeFile('session-missing.path', 'missing.jsonl');
    await writeFile('2000_session-archived.jsonl', '{"type":"session"}\n');
    const scan = await scanPiSessionOrphanFiles();

    await expect(
      deletePiSessionOrphanFiles([
        ...scan.dangling_path_files,
        ...scan.unmapped_jsonl_files,
      ]),
    ).resolves.toEqual({
      deleted_path_files: 1,
      deleted_jsonl_files: 1,
      skipped_unsafe_files: [],
    });

    await expect(
      fs.access(path.join(tempDir!, 'active.jsonl')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempDir!, 'session-missing.path')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(tempDir!, '2000_session-archived.jsonl')),
    ).rejects.toThrow();
  });
});
