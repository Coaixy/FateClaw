import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { piSessionStorageKey } from '@fateclaw/contracts/agent/session';

import {
  deletePiSessionFilesForSession,
  readPiSessionArchiveForSession,
  readPiSessionFileState,
  scanPiSessionOrphanFiles,
  writePiSessionArchiveToFiles,
  writePiSessionSnapshotArchiveToFiles,
  type PiSessionArchivePayload,
  mergePiSessionArchivePayload,
} from '#modules/chat/pi-session-files';

const sessionId = 'session-audience-test';
const firstAudience = 'sender:synthetic-s1';
const secondAudience = 'sender:synthetic-s2';
let root: string;
let directory: string;

async function seed(audience = '', generation = 0, prefix = 'saved') {
  const storageId = piSessionStorageKey(sessionId, generation, audience);
  const name = `${prefix}_${storageId}.jsonl`;
  const content = `${JSON.stringify({ type: 'session', id: storageId })}\n`;
  await fs.writeFile(path.join(directory, name), content);
  await fs.writeFile(path.join(directory, `${storageId}.path`), name);
  return { storageId, name, content };
}

async function seedEveryContext() {
  const contexts = [];
  for (const audience of ['', firstAudience, secondAudience]) {
    for (const generation of [0, 1])
      contexts.push(await seed(audience, generation));
  }
  return contexts;
}

describe('Pi session audience files', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-audience-files-'));
    directory = path.join(root, 'sessions');
    await fs.mkdir(directory);
    vi.stubEnv('FATECLAW_PI_SESSION_DIR', directory);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads distinct owner and sender mappings in both generations using the shared storage key', async () => {
    const files = await seedEveryContext();
    let index = 0;
    for (const audience of ['', firstAudience, secondAudience]) {
      for (const generation of [0, 1]) {
        const file = files[index++];
        await expect(
          readPiSessionFileState(sessionId, generation, audience),
        ).resolves.toMatchObject({
          mappingFile: path.join(directory, `${file.storageId}.path`),
          sessionFile: path.join(directory, file.name),
          hasSessionFile: true,
        });
      }
    }
    expect((await readPiSessionFileState(sessionId)).mappingFile).toBe(
      path.join(directory, `${sessionId}.path`),
    );
  });

  it('retains absent audiences when re-archiving a partially restored business session', async () => {
    await seedEveryContext();
    const original = await readPiSessionArchiveForSession(sessionId);
    await deletePiSessionFilesForSession(sessionId);
    await writePiSessionArchiveToFiles(sessionId, original.payload, 0, '');
    const partial = await readPiSessionArchiveForSession(sessionId);
    await expect(
      writePiSessionArchiveToFiles(
        sessionId,
        partial.payload,
        1,
        secondAudience,
      ),
    ).resolves.toEqual({ writtenSessionFiles: 0, writtenMappingFile: false });
    const retained = mergePiSessionArchivePayload(
      sessionId,
      original.payload,
      partial.payload,
    ) as PiSessionArchivePayload;
    await deletePiSessionFilesForSession(sessionId);
    await expect(
      writePiSessionArchiveToFiles(sessionId, retained, 1, secondAudience),
    ).resolves.toMatchObject({ writtenMappingFile: true });
    expect(
      (await readPiSessionFileState(sessionId, 1, secondAudience))
        .hasSessionFile,
    ).toBe(true);
  });

  it('binds snapshot restoration to its declared audience and rejects explicit audience changes', async () => {
    const owner = await seed();
    const snapshot = {
      contextAudience: firstAudience,
      contextGeneration: 1,
      messages: [{ role: 'user', content: 'Synthetic sender-only history' }],
    };
    const restored = await writePiSessionSnapshotArchiveToFiles(
      sessionId,
      snapshot,
    );
    const storageId = piSessionStorageKey(sessionId, 1, firstAudience);
    expect(restored?.payload.mapping_file_name).toBe(`${storageId}.path`);
    expect(restored?.payload.contexts).toHaveLength(2);
    expect(
      restored?.payload.files.some((file) => file.name === owner.name),
    ).toBe(true);
    expect(
      (await readPiSessionFileState(sessionId, 1, firstAudience))
        .hasSessionFile,
    ).toBe(true);
    expect(
      (await readPiSessionFileState(sessionId, 1, secondAudience))
        .hasMappingFile,
    ).toBe(false);
    await expect(
      writePiSessionSnapshotArchiveToFiles(
        sessionId,
        snapshot,
        1,
        secondAudience,
      ),
    ).rejects.toThrow(/audience/i);
    await expect(
      writePiSessionSnapshotArchiveToFiles(
        sessionId,
        { messages: snapshot.messages },
        0,
        firstAudience,
      ),
    ).rejects.toThrow(/audience/i);
    await expect(
      fs.readFile(path.join(directory, owner.name), 'utf8'),
    ).resolves.toBe(owner.content);
  });

  it('archives every context map without storing raw audience identities', async () => {
    const files = await seedEveryContext();
    const backup = `backup_${files[3].storageId}.jsonl`;
    await fs.writeFile(path.join(directory, backup), files[3].content);
    const archive = await readPiSessionArchiveForSession(
      sessionId,
      1,
      firstAudience,
    );
    expect(archive.sessionId).toBe(sessionId);
    expect(archive.payload.files.map((file) => file.name).sort()).toEqual(
      [...files.map((file) => file.name), backup].sort(),
    );
    expect(archive.payload.contexts).toHaveLength(6);
    for (const file of files) {
      expect(archive.payload.contexts).toContainEqual(
        expect.objectContaining({
          storage_id: file.storageId,
          mapping_file_name: `${file.storageId}.path`,
          mapping_content: file.name,
          file_names:
            file === files[3]
              ? expect.arrayContaining([file.name, backup])
              : [file.name],
        }),
      );
    }
    expect(JSON.stringify(archive.payload.contexts)).not.toContain(
      firstAudience,
    );
    expect(JSON.stringify(archive.payload.contexts)).not.toContain(
      secondAudience,
    );
    expect(archive.payload.mapping_file_name).toBe(
      `${piSessionStorageKey(sessionId, 1, firstAudience)}.path`,
    );
  });

  it('restores exactly the requested archived context without changing owner or another sender', async () => {
    const files = await seedEveryContext();
    const archive = await readPiSessionArchiveForSession(sessionId);
    await fs.rm(directory, { recursive: true });
    await fs.mkdir(directory);
    const owner = files[0],
      other = files[4],
      selected = files[3];
    await fs.writeFile(path.join(directory, owner.name), 'new owner history');
    await fs.writeFile(
      path.join(directory, `${owner.storageId}.path`),
      owner.name,
    );
    await fs.writeFile(
      path.join(directory, other.name),
      'new second-sender history',
    );
    await fs.writeFile(
      path.join(directory, `${other.storageId}.path`),
      other.name,
    );
    await expect(
      writePiSessionArchiveToFiles(
        sessionId,
        archive.payload,
        1,
        firstAudience,
      ),
    ).resolves.toEqual({ writtenSessionFiles: 1, writtenMappingFile: true });
    expect(
      (await readPiSessionFileState(sessionId, 1, firstAudience)).sessionFile,
    ).toBe(path.join(directory, selected.name));
    await expect(
      fs.readFile(path.join(directory, owner.name), 'utf8'),
    ).resolves.toBe('new owner history');
    await expect(
      fs.readFile(path.join(directory, other.name), 'utf8'),
    ).resolves.toBe('new second-sender history');
    expect((await fs.readdir(directory)).sort()).toEqual(
      [
        owner.name,
        `${owner.storageId}.path`,
        other.name,
        `${other.storageId}.path`,
        selected.name,
        `${selected.storageId}.path`,
      ].sort(),
    );
  });

  it('leaves existing files untouched when the requested context is absent or the archive is legacy', async () => {
    const owner = await seed();
    await seed(firstAudience);
    const archive = await readPiSessionArchiveForSession(sessionId);
    const other = await seed(secondAudience);
    const before = await fs.readdir(directory);
    await expect(
      writePiSessionArchiveToFiles(
        sessionId,
        archive.payload,
        0,
        secondAudience,
      ),
    ).resolves.toEqual({ writtenSessionFiles: 0, writtenMappingFile: false });
    const legacy: PiSessionArchivePayload = {
      ...archive.payload,
      contexts: undefined,
    };
    await expect(
      writePiSessionArchiveToFiles(sessionId, legacy, 0, firstAudience),
    ).resolves.toEqual({ writtenSessionFiles: 0, writtenMappingFile: false });
    await expect(
      writePiSessionArchiveToFiles(sessionId, legacy, 1, ''),
    ).resolves.toEqual({ writtenSessionFiles: 0, writtenMappingFile: false });
    await expect(
      writePiSessionArchiveToFiles(sessionId, legacy),
    ).resolves.toEqual({ writtenSessionFiles: 1, writtenMappingFile: true });
    expect((await fs.readdir(directory)).sort()).toEqual(before.sort());
    await expect(
      fs.readFile(path.join(directory, owner.name), 'utf8'),
    ).resolves.toBe(owner.content);
    await expect(
      fs.readFile(path.join(directory, other.name), 'utf8'),
    ).resolves.toBe(other.content);
  });

  it('does not restore cross-audience or foreign filenames from an incorrect context map', async () => {
    const owner = await seed();
    const other = await seed(secondAudience);
    const firstKey = piSessionStorageKey(sessionId, 0, firstAudience);
    await fs.writeFile(path.join(directory, `${firstKey}.path`), other.name);
    await expect(
      readPiSessionFileState(sessionId, 0, firstAudience),
    ).resolves.toMatchObject({ hasSessionFile: false });
    expect((await scanPiSessionOrphanFiles()).unsafe_path_files).toContain(
      `${firstKey}.path`,
    );
    const archive = await readPiSessionArchiveForSession(
      sessionId,
      0,
      firstAudience,
    );
    expect(
      archive.payload.contexts?.some(
        (context) => context.storage_id === firstKey,
      ),
    ).toBe(false);
    const payload: PiSessionArchivePayload = {
      ...archive.payload,
      contexts: [
        {
          storage_id: firstKey,
          context_generation: 0,
          audience_hash: firstKey.slice(`${sessionId}.aud-`.length),
          mapping_file_name: `${firstKey}.path`,
          mapping_content: owner.name,
          file_names: [
            owner.name,
            other.name,
            '../outside.jsonl',
            'saved_session-foreign.jsonl',
          ],
        },
      ],
    };
    await expect(
      writePiSessionArchiveToFiles(sessionId, payload, 0, firstAudience),
    ).resolves.toEqual({ writtenSessionFiles: 0, writtenMappingFile: false });
    await expect(
      fs.readFile(path.join(directory, owner.name), 'utf8'),
    ).resolves.toBe(owner.content);
    await expect(
      fs.readFile(path.join(directory, other.name), 'utf8'),
    ).resolves.toBe(other.content);
  });

  it('attributes valid audience files to the business session and deletes all owned contexts conservatively', async () => {
    const files = await seedEveryContext();
    await fs.unlink(path.join(directory, `${files[3].storageId}.path`));
    await fs.unlink(path.join(directory, files[4].name));
    await fs.writeFile(
      path.join(
        directory,
        'saved_session-other.aud-0123456789abcdef0123456789abcdef.memory-1.jsonl',
      ),
      'unrelated',
    );
    const unknown = `${sessionId}.aud-unknown.jsonl`;
    await fs.writeFile(path.join(directory, unknown), 'unrecognized context');
    const scan = await scanPiSessionOrphanFiles();
    expect(scan.unmapped_jsonl_files).toContainEqual(
      expect.objectContaining({ name: files[3].name, session_id: sessionId }),
    );
    expect(scan.dangling_path_files).toContainEqual(
      expect.objectContaining({
        name: `${files[4].storageId}.path`,
        session_id: sessionId,
      }),
    );
    expect(scan.unmapped_jsonl_files).toContainEqual(
      expect.objectContaining({ name: unknown, session_id: null }),
    );
    await expect(
      deletePiSessionFilesForSession(sessionId, 1, firstAudience),
    ).resolves.toMatchObject({
      sessionId,
      deletedMappingFile: true,
      deletedSessionFiles: 5,
    });
    expect((await fs.readdir(directory)).sort()).toEqual(
      [
        unknown,
        'saved_session-other.aud-0123456789abcdef0123456789abcdef.memory-1.jsonl',
      ].sort(),
    );
  });
});
