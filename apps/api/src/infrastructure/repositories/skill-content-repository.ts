import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  type SkillContent,
  type SkillContentRevision,
} from '@fateclaw/contracts/skills/content';

export async function insertSkillContentRevision(
  client: Pick<pg.PoolClient, 'query'>,
  skillId: string,
  content: SkillContent,
): Promise<SkillContentRevision> {
  const revisionId = randomUUID();
  await client.query(
    `INSERT INTO skill_content_revisions
       (id, skill_id, format_version, checksum, files, content_length)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      revisionId,
      skillId,
      content.formatVersion,
      content.checksum,
      JSON.stringify(content.files),
      content.contentLength,
    ],
  );
  return { ...content, skillId, revisionId };
}
