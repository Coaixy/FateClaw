import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deletePiSessionFilesForSession,
  readPiSessionArchiveForSession,
  readPiSessionFileState,
  scanPiSessionOrphanFiles,
  writePiSessionArchiveToFiles,
  writePiSessionSnapshotArchiveToFiles,
  type PiSessionArchivePayload,
} from '#modules/chat/pi-session-files';

let tempRoot: string;
let sessionDir: string;
const sessionId = 'session-generation-test';

async function write(name: string, content: string) {
  await fs.writeFile(path.join(sessionDir, name), content, 'utf8');
}

async function seedGeneration(generation: number, prefix = 'saved') {
  const storageId = `${sessionId}${generation ? `.memory-${generation}` : ''}`;
  const fileName = `${prefix}_${storageId}.jsonl`;
  await write(fileName, `{"type":"session","id":"${storageId}"}\n`);
  await write(`${storageId}.path`, fileName);
  return fileName;
}

describe('Pi session context generations', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'pi-memory-generations-'),
    );
    sessionDir = path.join(tempRoot, 'sessions');
    await fs.mkdir(sessionDir);
    vi.stubEnv('FATECLAW_PI_SESSION_DIR', sessionDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('keeps generation zero compatible and never falls back to it for a reset context', async () => {
    const original = await seedGeneration(0);
    await expect(readPiSessionFileState(sessionId)).resolves.toMatchObject({
      mappingFile: path.join(sessionDir, `${sessionId}.path`),
      sessionFile: path.join(sessionDir, original),
      hasSessionFile: true,
    });
    await expect(readPiSessionFileState(sessionId, 1)).resolves.toMatchObject({
      mappingFile: path.join(sessionDir, `${sessionId}.memory-1.path`),
      hasSessionFile: false,
    });
    const reset = await seedGeneration(1);
    await expect(readPiSessionFileState(sessionId, 1)).resolves.toMatchObject({
      sessionFile: path.join(sessionDir, reset),
      hasSessionFile: true,
    });
    await write(`${sessionId}.memory-2.path`, original);
    await expect(readPiSessionFileState(sessionId, 2)).resolves.toMatchObject({
      hasSessionFile: false,
    });
  });

  it('restores snapshots only into their own declared generation', async () => {
    const original = await seedGeneration(0);
    const snapshot = {
      contextGeneration: 2,
      messages: [{ role: 'user', content: 'Synthetic new context' }],
    };
    const restored = await writePiSessionSnapshotArchiveToFiles(
      sessionId,
      snapshot,
    );
    expect(restored?.payload.context_generation).toBe(2);
    expect(restored?.payload.mapping_file_name).toBe(
      `${sessionId}.memory-2.path`,
    );
    const current = await readPiSessionFileState(sessionId, 2);
    expect(current.hasSessionFile).toBe(true);
    expect(
      JSON.parse(
        (await fs.readFile(current.sessionFile!, 'utf8')).split('\n')[0],
      ).id,
    ).toBe(`${sessionId}.memory-2`);
    await expect(
      fs.readFile(path.join(sessionDir, `${sessionId}.path`), 'utf8'),
    ).resolves.toBe(original);
    await expect(
      writePiSessionSnapshotArchiveToFiles(sessionId, snapshot, 3),
    ).rejects.toThrow(/generation/i);
    await expect(
      writePiSessionSnapshotArchiveToFiles(
        sessionId,
        { messages: snapshot.messages },
        2,
      ),
    ).rejects.toThrow(/generation/i);
    expect((await readPiSessionFileState(sessionId, 3)).hasMappingFile).toBe(
      false,
    );
  });

  it('archives all owned generations and restores the matching mapping without touching another session', async () => {
    const original = await seedGeneration(0);
    const current = await seedGeneration(1);
    const later = await seedGeneration(2);
    await write('saved_session-unrelated.memory-1.jsonl', 'unrelated');
    const archive = await readPiSessionArchiveForSession(sessionId, 1);
    expect(archive.sessionId).toBe(sessionId);
    expect(archive.payload).toMatchObject({
      context_generation: 1,
      mapping_file_name: `${sessionId}.memory-1.path`,
      mapping_content: current,
    });
    expect(archive.payload.files.map((file) => file.name).sort()).toEqual(
      [original, current, later].sort(),
    );
    await fs.rm(sessionDir, { recursive: true });
    await fs.mkdir(sessionDir);
    await write('saved_session-unrelated.memory-1.jsonl', 'unrelated');
    await expect(
      writePiSessionArchiveToFiles(sessionId, archive.payload, 1),
    ).resolves.toMatchObject({
      writtenSessionFiles: 1,
      writtenMappingFile: true,
    });
    expect((await readPiSessionFileState(sessionId, 1)).sessionFile).toBe(
      path.join(sessionDir, current),
    );
    expect((await readPiSessionFileState(sessionId)).hasMappingFile).toBe(
      false,
    );
    await expect(fs.access(path.join(sessionDir, original))).rejects.toThrow();
    await expect(fs.access(path.join(sessionDir, later))).rejects.toThrow();
    await expect(
      fs.readFile(
        path.join(sessionDir, 'saved_session-unrelated.memory-1.jsonl'),
        'utf8',
      ),
    ).resolves.toBe('unrelated');
    await expect(
      writePiSessionArchiveToFiles(sessionId, archive.payload, 2),
    ).resolves.toEqual({ writtenSessionFiles: 1, writtenMappingFile: true });
    expect((await readPiSessionFileState(sessionId, 2)).sessionFile).toBe(
      path.join(sessionDir, later),
    );
    expect((await readPiSessionFileState(sessionId, 1)).sessionFile).toBe(
      path.join(sessionDir, current),
    );
  });

  it('does not construct a new-generation mapping from legacy-only archive files', async () => {
    const original = await seedGeneration(0);
    const archived = await readPiSessionArchiveForSession(sessionId, 1);
    expect(archived.payload.mapping_content).toBeNull();
    const legacy: PiSessionArchivePayload = {
      ...archived.payload,
      context_generation: undefined,
      contexts: undefined,
      mapping_file_name: `${sessionId}.path`,
      mapping_content: original,
    };
    await expect(
      writePiSessionArchiveToFiles(sessionId, legacy, 1),
    ).resolves.toEqual({ writtenSessionFiles: 0, writtenMappingFile: false });
    const malformed = { ...archived.payload, mapping_content: original };
    await expect(
      writePiSessionArchiveToFiles(sessionId, malformed, 1),
    ).resolves.toMatchObject({
      writtenSessionFiles: 0,
      writtenMappingFile: false,
    });
    expect((await readPiSessionFileState(sessionId, 1)).hasMappingFile).toBe(
      false,
    );
  });

  it('attributes generation files to the business session during orphan scanning', async () => {
    await write(
      `${sessionId}.memory-1.path`,
      `missing_${sessionId}.memory-1.jsonl`,
    );
    await write(
      `old_${sessionId}.memory-2.jsonl`,
      'synthetic unmapped generation',
    );
    const scan = await scanPiSessionOrphanFiles();
    expect(scan.dangling_path_files).toEqual([
      expect.objectContaining({
        name: `${sessionId}.memory-1.path`,
        session_id: sessionId,
      }),
    ]);
    expect(scan.unmapped_jsonl_files).toEqual([
      expect.objectContaining({
        name: `old_${sessionId}.memory-2.jsonl`,
        session_id: sessionId,
      }),
    ]);
  });

  it('preserves legacy mapping filenames and excludes unrelated archive entries', async () => {
    await write(`${sessionId}.path`, 'legacy-history.jsonl');
    await write('legacy-history.jsonl', 'synthetic legacy history');
    await write('unrelated.jsonl', 'keep unrelated history');
    const archive = await readPiSessionArchiveForSession(sessionId);
    const payload = {
      ...archive.payload,
      files: [
        ...archive.payload.files,
        {
          name: 'unrelated.jsonl',
          content: 'must not overwrite',
          size_bytes: 18,
          modified_at: null,
        },
      ],
    };
    await expect(
      writePiSessionArchiveToFiles(sessionId, payload),
    ).resolves.toEqual({ writtenSessionFiles: 1, writtenMappingFile: true });
    expect((await readPiSessionFileState(sessionId, 0)).sessionFile).toBe(
      path.join(sessionDir, 'legacy-history.jsonl'),
    );
    await expect(
      fs.readFile(path.join(sessionDir, 'unrelated.jsonl'), 'utf8'),
    ).resolves.toBe('keep unrelated history');
  });

  it('does not read or overwrite a linked file outside the session directory', async () => {
    const fileName = `linked_${sessionId}.memory-1.jsonl`;
    const outside = path.join(tempRoot, 'outside.jsonl');
    await fs.writeFile(outside, 'synthetic outside history');
    await fs.symlink(outside, path.join(sessionDir, fileName));
    await write(`${sessionId}.memory-1.path`, fileName);
    expect((await readPiSessionFileState(sessionId, 1)).hasSessionFile).toBe(
      false,
    );
    const archive = await readPiSessionArchiveForSession(sessionId, 1);
    expect(archive.payload.files).toEqual([]);
    expect(archive.skippedUnsafeSessionFiles).toContain(
      path.join(sessionDir, fileName),
    );
    const payload = {
      ...archive.payload,
      mapping_content: fileName,
      contexts: archive.payload.contexts?.map((context) => ({
        ...context,
        mapping_content: fileName,
        file_names: [fileName],
      })),
      files: [
        {
          name: fileName,
          content: 'must not overwrite',
          size_bytes: 18,
          modified_at: null,
        },
      ],
    };
    await expect(
      writePiSessionArchiveToFiles(sessionId, payload, 1),
    ).rejects.toThrow();
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe(
      'synthetic outside history',
    );
  });

  it('deletes every owned generation while preserving unrelated mappings and external files', async () => {
    await seedGeneration(0);
    await seedGeneration(1);
    await seedGeneration(2);
    await write('session-unrelated.path', 'saved_session-unrelated.jsonl');
    await write('saved_session-unrelated.jsonl', 'unrelated');
    const outside = path.join(tempRoot, 'outside.jsonl');
    await fs.writeFile(outside, 'synthetic outside content');
    await write(`${sessionId}.memory-3.path`, outside);
    const deleted = await deletePiSessionFilesForSession(sessionId, 1);
    expect(deleted).toMatchObject({
      sessionId,
      deletedMappingFile: true,
      deletedSessionFiles: 3,
    });
    expect(deleted.skippedUnsafeSessionFiles).toContain(outside);
    expect((await fs.readdir(sessionDir)).sort()).toEqual([
      'saved_session-unrelated.jsonl',
      'session-unrelated.path',
    ]);
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe(
      'synthetic outside content',
    );
  });
});
