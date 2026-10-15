import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDbPool, initDbPool } from '../../src/infrastructure/db-pool.js';
import { runDatabaseMigrations } from '../../src/infrastructure/migrations/runner.js';
import {
  createUserCustomSkill,
  getUserCustomSkill,
  updateUserCustomSkill,
} from '../../src/infrastructure/repositories/skills-repository.js';
import {
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
} from '../../src/infrastructure/repositories/admin-repository.js';
import { importLegacySkillContent } from '../../src/modules/skills/legacy-skill-import.js';
import { SkillRevisionConflictError } from '../../src/modules/skills/skill-errors.js';
import {
  closeAgentDb,
  queryEffectiveUserSkills,
  querySkillContentRevision,
} from '../../../agent-runtime/src/agent-db.js';
import { SkillContentCache } from '../../../agent-runtime/src/skill-content-cache.js';

// The opt-in server must be disposable and allow CREATE DATABASE; no workspace .env is loaded.
const connectionString = process.env.FATECLAW_TEST_MIGRATIONS_DATABASE_URL;

describe.skipIf(!connectionString)(
  'database-backed user skill bundles PostgreSQL integration',
  () => {
    const databaseName = `fateclaw_skills_test_${randomUUID().replaceAll('-', '')}`;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalCacheRoot = process.env.FATECLAW_TEXT_SKILLS_DIR;
    const roots: string[] = [];
    let admin: pg.Pool;
    let db: pg.Pool;
    let created = false;

    function emptyDeployment(): string {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fateclaw-skill-deployment-'),
      );
      roots.push(root);
      process.env.FATECLAW_TEXT_SKILLS_DIR = root;
      return root;
    }

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const url = new URL(connectionString!);
      url.pathname = `/${databaseName}`;
      process.env.DATABASE_URL = url.toString();
      db = initDbPool(url.toString());
      const client = await db.connect();
      try {
        await runDatabaseMigrations(client);
      } finally {
        client.release();
      }
      await db.query(
        "INSERT INTO users (id, created_at) VALUES ('skill-owner', NOW())",
      );
    });

    afterAll(async () => {
      await closeAgentDb();
      await closeDbPool();
      if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin?.end();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalCacheRoot === undefined)
        delete process.env.FATECLAW_TEXT_SKILLS_DIR;
      else process.env.FATECLAW_TEXT_SKILLS_DIR = originalCacheRoot;
      for (const root of roots)
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('uses PostgreSQL as the canonical source across cache loss, edits, deployments, and legacy backfill', async () => {
      const firstRoot = emptyDeployment();
      const files = [
        {
          path: 'SKILL.md',
          content:
            '---\nname: Database Skill\ndescription: Synthetic knowledge\n---\n# Skill',
        },
        { path: 'docs/中文.md', content: '跨区域知识' },
        { path: 'examples/example.py', content: 'print("example")' },
      ];
      const createdSkill = await createUserCustomSkill({
        id: 'database-skill',
        user_id: 'skill-owner',
        skill_name: 'Database Skill',
        dir_name: 'database-skill',
        files,
      });
      expect(createdSkill.files).toEqual(files);
      expect(fs.readdirSync(firstRoot)).toEqual([]);
      expect((await getCustomSkillForAdmin('database-skill'))?.files).toEqual(
        files,
      );
      const { rows } = await db.query(
        'SELECT files FROM skill_content_revisions WHERE id = $1',
        [createdSkill.revision_id],
      );
      expect(rows[0].files).toEqual(files);

      const authorized = await queryEffectiveUserSkills('skill-owner');
      expect(authorized).toHaveLength(1);
      expect(authorized[0].revision_id).toBe(createdSkill.revision_id);
      expect(await queryEffectiveUserSkills('unrelated-user')).toEqual([]);
      const input = {
        skillId: 'database-skill',
        checksum: authorized[0].checksum!,
        revisionId: authorized[0].revision_id!,
        formatVersion: authorized[0].format_version!,
      };
      const cache = new SkillContentCache({ root: firstRoot });
      const read = () =>
        querySkillContentRevision('database-skill', input.revisionId);
      const first = await cache.acquire(input, read);
      expect(first.baseDir.startsWith(firstRoot)).toBe(true);
      fs.rmSync(firstRoot, { recursive: true });
      expect(
        (await getUserCustomSkill('database-skill', 'skill-owner'))?.files,
      ).toEqual(files);
      const restored = await cache.acquire(input, read);
      expect(
        fs.readFileSync(path.join(restored.baseDir, 'docs/中文.md'), 'utf8'),
      ).toBe('跨区域知识');

      const replacement = [
        files[0],
        { path: 'docs/中文.md', content: 'Updated knowledge' },
      ];
      const updated = await updateUserCustomSkill(
        'database-skill',
        'skill-owner',
        { files: replacement, base_revision_id: createdSkill.revision_id },
      );
      expect(updated?.files).toEqual(replacement);
      expect(updated?.checksum).not.toBe(createdSkill.checksum);
      expect(
        await querySkillContentRevision(
          'database-skill',
          createdSkill.revision_id!,
        ),
      ).toMatchObject({ files });
      const secondRoot = emptyDeployment();
      const otherDeployment = await new SkillContentCache({
        root: secondRoot,
      }).acquire(
        {
          skillId: 'database-skill',
          revisionId: updated!.revision_id!,
          checksum: updated!.checksum!,
          formatVersion: updated!.format_version!,
        },
        () =>
          querySkillContentRevision('database-skill', updated!.revision_id!),
      );
      expect(otherDeployment.baseDir.startsWith(secondRoot)).toBe(true);
      expect(
        fs.readFileSync(
          path.join(otherDeployment.baseDir, 'docs/中文.md'),
          'utf8',
        ),
      ).toBe('Updated knowledge');
      expect(
        fs.existsSync(path.join(otherDeployment.baseDir, 'examples')),
      ).toBe(false);
      expect(
        fs.readFileSync(path.join(restored.baseDir, 'docs/中文.md'), 'utf8'),
      ).toBe('跨区域知识');

      first.release();
      restored.release();
      otherDeployment.release();
    });
    async function createSkill(id: string) {
      return createUserCustomSkill({
        id,
        user_id: 'skill-owner',
        skill_name: id,
        dir_name: id,
        files: [{ path: 'SKILL.md', content: `# ${id}` }],
      });
    }

    it('keeps a selected old revision available even after an edit and a cold cache', async () => {
      const before = await createSkill('revision-race');
      await updateUserCustomSkill(before.id, 'skill-owner', {
        base_revision_id: before.revision_id,
        files: [{ path: 'SKILL.md', content: '# Changed' }],
      });
      const selected = await querySkillContentRevision(
        before.id,
        before.revision_id!,
      );
      expect(selected?.files).toEqual(before.files);
      const snapshot = await new SkillContentCache({
        root: emptyDeployment(),
      }).acquire(
        {
          skillId: before.id,
          revisionId: before.revision_id!,
          checksum: before.checksum!,
          formatVersion: before.format_version!,
        },
        () => querySkillContentRevision(before.id, before.revision_id!),
      );
      expect(fs.readFileSync(snapshot.filePath, 'utf8')).toBe(
        '# revision-race',
      );
      snapshot.release();
    });

    it('accepts only one concurrent save from a base revision and rolls back conflicting metadata and content', async () => {
      const before = await createSkill('concurrent-saves');
      const results = await Promise.allSettled(
        ['One', 'Two'].map((name) =>
          updateUserCustomSkill(before.id, 'skill-owner', {
            base_revision_id: before.revision_id,
            skill_name: name,
            files: [{ path: 'SKILL.md', content: `# ${name}` }],
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const failure = results.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(failure.reason).toBeInstanceOf(SkillRevisionConflictError);
      const winner = (
        results.find(
          (result) => result.status === 'fulfilled',
        ) as PromiseFulfilledResult<NonNullable<typeof before>>
      ).value;
      const current = await getUserCustomSkill(before.id, 'skill-owner');
      expect(current?.revision_id).toBe(winner.revision_id);
      expect(current?.files).toEqual(winner.files);
      expect(current?.skill_name).toBe(winner.skill_name);
      const count = await db.query(
        'SELECT COUNT(*)::int AS count FROM skill_content_revisions WHERE skill_id = $1',
        [before.id],
      );
      expect(count.rows[0].count).toBe(2);
    });

    it('enforces immutable revisions and same-skill pointers, and rolls back failed saves without orphan revisions', async () => {
      const before = await createSkill('atomic-save');
      const other = await createSkill('other-content-owner');
      await expect(
        db.query(
          'UPDATE skill_content_revisions SET files = $1 WHERE id = $2',
          [
            JSON.stringify([{ path: 'SKILL.md', content: '# Modified' }]),
            before.revision_id,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          'UPDATE user_custom_skills SET current_revision_id = $1 WHERE id = $2',
          [other.revision_id, before.id],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        updateUserCustomSkill(before.id, 'skill-owner', {
          base_revision_id: before.revision_id,
          dir_name: other.dir_name,
          files: [{ path: 'SKILL.md', content: '# Fails' }],
        }),
      ).rejects.toMatchObject({ code: '23505' });
      expect(
        (await getUserCustomSkill(before.id, 'skill-owner'))?.revision_id,
      ).toBe(before.revision_id);
      const count = await db.query(
        'SELECT COUNT(*)::int AS count FROM skill_content_revisions WHERE skill_id = $1',
        [before.id],
      );
      expect(count.rows[0].count).toBe(1);
    });

    it('reports current database metadata and bounded revision history without file bodies in the admin list', async () => {
      const initial = await createSkill('admin-metadata');
      let current = initial;
      for (let index = 0; index < 21; index += 1) {
        current = (await updateUserCustomSkill(initial.id, 'skill-owner', {
          base_revision_id: current.revision_id,
          files: [
            { path: 'SKILL.md', content: `# Revision ${index}` },
            { path: 'docs/detail.md', content: 'Private knowledge' },
          ],
        }))!;
      }
      const summary = (
        await getCustomSkillsForAdmin({ userId: 'skill-owner' })
      ).find((skill) => skill.id === initial.id)!;
      expect(summary).not.toHaveProperty('files');
      expect(summary).not.toHaveProperty('revisions');
      expect(summary.storage).toMatchObject({
        state: 'stored',
        current_revision_id: current.revision_id,
        revision_count: 22,
        file_count: 2,
        format_version: 1,
        import_status: null,
      });
      const detail = (await getCustomSkillForAdmin(initial.id))!;
      expect(detail.storage).toEqual(summary.storage);
      expect(detail.files).toEqual(current.files);
      expect(detail.content_length).toBe(current.content_length);
      expect(detail.storage.revision_created_at).toBeTruthy();
      expect(detail.revisions).toHaveLength(20);
      expect(detail.revisions[0]).toMatchObject({
        id: current.revision_id,
        checksum: current.checksum,
        file_count: 2,
      });
      expect(
        detail.revisions.some(
          (revision) => revision.id === initial.revision_id,
        ),
      ).toBe(false);
      expect(await getCustomSkillForAdmin('absent-skill')).toBeUndefined();
    });

    it('records legacy import outcomes durably, retries missing files, and never duplicates completed imports', async () => {
      const location = emptyDeployment();
      const legacy = path.join(location, 'legacy');
      fs.mkdirSync(path.join(legacy, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'SKILL.md'), '# Legacy');
      fs.writeFileSync(path.join(legacy, 'docs/中文.md'), 'Legacy knowledge');
      const files = [
        { path: 'SKILL.md', content: '# Legacy' },
        { path: 'docs/中文.md', content: 'Legacy knowledge' },
      ];
      const hash = createHash('sha256');
      for (const file of [...files].sort((a, b) =>
        a.path.localeCompare(b.path),
      ))
        hash.update(file.path).update('\0').update(file.content).update('\0');
      await db.query(
        `INSERT INTO user_custom_skills
        (id, user_id, skill_name, dir_name, bundle_uri, checksum, install_status)
        VALUES ('legacy-skill', 'skill-owner', 'Legacy', 'legacy', $1, $2, 'installed'),
          ('missing-legacy', 'skill-owner', 'Missing', 'missing', $3, NULL, 'installed')`,
        [legacy, hash.digest('hex'), path.join(location, 'missing')],
      );
      expect(await importLegacySkillContent(db)).toEqual({
        migrated: 1,
        missing: 1,
        mismatched: 0,
        invalid: 0,
      });
      const statuses = await db.query(
        'SELECT skill_id, status, error_code FROM skill_content_imports ORDER BY skill_id',
      );
      expect(statuses.rows).toContainEqual({
        skill_id: 'legacy-skill',
        status: 'complete',
        error_code: null,
      });
      expect(statuses.rows).toContainEqual({
        skill_id: 'missing-legacy',
        status: 'missing',
        error_code: 'legacy_files_missing',
      });
      fs.rmSync(legacy, { recursive: true });
      expect(
        (await getUserCustomSkill('legacy-skill', 'skill-owner'))?.files,
      ).toEqual(files);
      fs.mkdirSync(path.join(location, 'missing'));
      fs.writeFileSync(path.join(location, 'missing/SKILL.md'), '# Recovered');
      const [first, second] = await Promise.all([
        importLegacySkillContent(db),
        importLegacySkillContent(db),
      ]);
      expect(first.migrated + second.migrated).toBe(1);
      expect(await importLegacySkillContent(db)).toEqual({
        migrated: 0,
        missing: 0,
        mismatched: 0,
        invalid: 0,
      });
      const count = await db.query(
        "SELECT COUNT(*)::int AS count FROM skill_content_revisions WHERE skill_id IN ('legacy-skill', 'missing-legacy')",
      );
      expect(count.rows[0].count).toBe(2);
    });

    it('keeps invalid or mismatched legacy content pending with durable reasons and no partial revisions', async () => {
      const location = emptyDeployment();
      for (const name of ['mismatched', 'invalid']) {
        fs.mkdirSync(path.join(location, name));
        fs.writeFileSync(
          path.join(location, name, 'SKILL.md'),
          name === 'invalid' ? 'invalid\0text' : '# Mismatched',
        );
      }
      await db.query(
        `INSERT INTO user_custom_skills
        (id, user_id, skill_name, dir_name, bundle_uri, checksum)
        VALUES ('legacy-mismatched', 'skill-owner', 'Mismatched', 'legacy-mismatched', $1, $2),
          ('legacy-invalid', 'skill-owner', 'Invalid', 'legacy-invalid', $3, NULL)`,
        [
          path.join(location, 'mismatched'),
          'a'.repeat(64),
          path.join(location, 'invalid'),
        ],
      );
      expect(await importLegacySkillContent(db)).toEqual({
        migrated: 0,
        missing: 0,
        mismatched: 1,
        invalid: 1,
      });
      const statuses =
        await db.query(`SELECT skill_id, status, error_code FROM skill_content_imports
        WHERE skill_id IN ('legacy-mismatched', 'legacy-invalid') ORDER BY skill_id`);
      expect(statuses.rows).toEqual([
        {
          skill_id: 'legacy-invalid',
          status: 'invalid',
          error_code: 'legacy_content_invalid',
        },
        {
          skill_id: 'legacy-mismatched',
          status: 'mismatched',
          error_code: 'legacy_checksum_mismatch',
        },
      ]);
      const count =
        await db.query(`SELECT COUNT(*)::int AS count FROM skill_content_revisions
        WHERE skill_id IN ('legacy-mismatched', 'legacy-invalid')`);
      expect(count.rows[0].count).toBe(0);
      const failed = (await getCustomSkillForAdmin('legacy-mismatched'))!;
      expect(failed.storage).toMatchObject({
        state: 'mismatched',
        current_revision_id: null,
        revision_count: 0,
        file_count: 0,
        import_error_code: 'legacy_checksum_mismatch',
      });
      expect(failed.files).toEqual([]);
      expect(failed.revisions).toEqual([]);
    });
  },
);
