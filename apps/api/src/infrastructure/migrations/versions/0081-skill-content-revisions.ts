import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const skillContentRevisionsMigration: DatabaseMigration = {
  id: '0081_skill_content_revisions',
  description:
    'Store immutable skill content revisions and legacy import outcomes',
  async up(client) {
    await client.query(`
      CREATE TABLE skill_content_revisions (
        id text PRIMARY KEY,
        skill_id text NOT NULL REFERENCES user_custom_skills(id) ON DELETE CASCADE,
        format_version integer NOT NULL CHECK (format_version > 0),
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
        content_length integer NOT NULL CHECK (content_length >= 0),
        created_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (skill_id, id),
        CHECK (format_version <> 1 OR files @> '[{"path":"SKILL.md"}]'::jsonb)
      );
      CREATE FUNCTION reject_skill_content_revision_update() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'Skill content revisions are immutable' USING ERRCODE = '23514';
        END;
        $$;
      CREATE TRIGGER skill_content_revision_immutable
        BEFORE UPDATE ON skill_content_revisions
        FOR EACH ROW EXECUTE FUNCTION reject_skill_content_revision_update();

      ALTER TABLE user_custom_skills ADD COLUMN current_revision_id text;
      ALTER TABLE user_custom_skills ADD CONSTRAINT fk_skill_current_revision
        FOREIGN KEY (id, current_revision_id)
        REFERENCES skill_content_revisions(skill_id, id) DEFERRABLE INITIALLY DEFERRED;

      CREATE TABLE skill_content_imports (
        skill_id text PRIMARY KEY REFERENCES user_custom_skills(id) ON DELETE CASCADE,
        status text NOT NULL CHECK (status IN ('pending', 'missing', 'mismatched', 'invalid', 'complete')),
        error_code text,
        checked_at timestamptz,
        CHECK ((status = 'complete' AND error_code IS NULL) OR status <> 'complete')
      );
      INSERT INTO skill_content_imports (skill_id, status)
        SELECT id, 'pending' FROM user_custom_skills WHERE deleted_at IS NULL;
    `);
  },
};
