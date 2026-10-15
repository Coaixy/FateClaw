import type pg from 'pg';
import { createHash } from 'node:crypto';
import {
  prepareSkillContent,
  SkillContentValidationError,
} from '@fateclaw/contracts/skills/content';
import { insertSkillContentRevision } from '../../infrastructure/repositories/skill-content-repository.js';
import { readLegacySkillFiles } from './legacy-skill-files.js';

interface LegacySkill {
  id: string;
  bundle_uri: string;
  checksum: string | null;
  updated_at: string;
}

function legacyChecksum(
  files: Array<{ path: string; content: string }>,
  locale: boolean,
): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) =>
    locale
      ? a.path.localeCompare(b.path)
      : a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0,
  );
  for (const file of sorted)
    hash.update(file.path).update('\0').update(file.content).update('\0');
  return hash.digest('hex');
}

export async function importLegacySkillContent(
  db: Pick<pg.Pool, 'query' | 'connect'>,
): Promise<{
  migrated: number;
  missing: number;
  mismatched: number;
  invalid: number;
}> {
  let cursor = '';
  const result = { migrated: 0, missing: 0, mismatched: 0, invalid: 0 };
  for (;;) {
    const { rows } = await db.query<LegacySkill>(
      `SELECT id, bundle_uri, checksum, updated_at::text AS updated_at FROM user_custom_skills
       WHERE current_revision_id IS NULL AND deleted_at IS NULL AND id > $1 ORDER BY id LIMIT 100`,
      [cursor],
    );
    if (rows.length === 0) return result;
    for (const skill of rows) {
      cursor = skill.id;
      const recordFailure = async (
        status: 'missing' | 'mismatched' | 'invalid',
        code: string,
      ) => {
        const recorded = await db.query(
          `INSERT INTO skill_content_imports (skill_id, status, error_code, checked_at)
          SELECT id, $2, $3, NOW() FROM user_custom_skills
          WHERE id = $1 AND current_revision_id IS NULL AND deleted_at IS NULL
          ON CONFLICT (skill_id) DO UPDATE SET status = EXCLUDED.status,
            error_code = EXCLUDED.error_code, checked_at = EXCLUDED.checked_at
          WHERE skill_content_imports.status <> 'complete'`,
          [skill.id, status, code],
        );
        result[status] += recorded.rowCount ?? 0;
      };
      let files;
      try {
        files = readLegacySkillFiles(skill.bundle_uri);
        if (!files.length) {
          await recordFailure('missing', 'legacy_files_missing');
          continue;
        }
        prepareSkillContent(files);
      } catch (err) {
        if (!(err instanceof SkillContentValidationError)) throw err;
        await recordFailure('invalid', 'legacy_content_invalid');
        continue;
      }
      if (
        skill.checksum &&
        ![legacyChecksum(files, true), legacyChecksum(files, false)].includes(
          skill.checksum,
        )
      ) {
        await recordFailure('mismatched', 'legacy_checksum_mismatch');
        continue;
      }
      const content = prepareSkillContent(files);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          `SELECT id FROM user_custom_skills
          WHERE id = $1 AND current_revision_id IS NULL AND deleted_at IS NULL
            AND bundle_uri = $2 AND checksum IS NOT DISTINCT FROM $3 AND updated_at = $4::timestamptz
          FOR UPDATE`,
          [skill.id, skill.bundle_uri, skill.checksum, skill.updated_at],
        );
        if (locked.rows.length === 0) {
          await client.query('ROLLBACK');
          continue;
        }
        const revision = await insertSkillContentRevision(
          client,
          skill.id,
          content,
        );
        await client.query(
          `UPDATE user_custom_skills SET current_revision_id = $1,
          install_status = 'installed' WHERE id = $2`,
          [revision.revisionId, skill.id],
        );
        await client.query(
          `INSERT INTO skill_content_imports (skill_id, status, checked_at)
          VALUES ($1, 'complete', NOW()) ON CONFLICT (skill_id) DO UPDATE
          SET status = 'complete', error_code = NULL, checked_at = EXCLUDED.checked_at`,
          [skill.id],
        );
        await client.query('COMMIT');
        result.migrated += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  }
}
