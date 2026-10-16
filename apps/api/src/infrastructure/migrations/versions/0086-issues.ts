import type { DatabaseMigration } from '../types.js';

export const issuesMigration: DatabaseMigration = {
  id: '0086_issues',
  description: 'Add anonymous public issues with private account attribution',
  async up(client) {
    await client.query(`
      CREATE TABLE issues (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        author_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
        body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000),
        kind text NOT NULL CHECK (kind IN ('bug','feature')),
        state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
        close_reason text CHECK (close_reason IN ('resolved','not_planned','duplicate')),
        labels text[] NOT NULL DEFAULT '{}' CHECK (labels <@ ARRAY['needs_info','confirmed','planned','in_progress']::text[] AND cardinality(labels)<=4),
        locked boolean NOT NULL DEFAULT false,
        hidden boolean NOT NULL DEFAULT false,
        request_key uuid NOT NULL,
        request_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (author_user_id,request_key),
        CHECK ((state='open' AND close_reason IS NULL) OR (state='closed' AND close_reason IS NOT NULL))
      );
      CREATE INDEX issues_author_created ON issues(author_user_id,created_at DESC);
      CREATE INDEX issues_public_updated ON issues(updated_at DESC,id DESC) WHERE NOT hidden;
      CREATE TABLE issue_participants (
        issue_id integer NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        participant_number integer NOT NULL CHECK (participant_number>=0),
        PRIMARY KEY (issue_id,user_id), UNIQUE (issue_id,participant_number)
      );
      CREATE INDEX issue_participants_user ON issue_participants(user_id);
      CREATE TABLE issue_entries (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        issue_id integer NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        actor_kind text NOT NULL CHECK (actor_kind IN ('user','official')),
        actor_user_id text REFERENCES users(id) ON DELETE CASCADE,
        type text NOT NULL CHECK (type IN ('comment','edited','closed','reopened','labels_changed','locked','unlocked')),
        body text,
        close_reason text CHECK (close_reason IN ('resolved','not_planned','duplicate')),
        hidden boolean NOT NULL DEFAULT false,
        request_key uuid,
        request_hash text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((actor_kind='user' AND actor_user_id IS NOT NULL) OR (actor_kind='official' AND actor_user_id IS NULL)),
        CHECK ((type='comment' AND body IS NOT NULL AND char_length(btrim(body)) BETWEEN 1 AND 2000 AND request_key IS NOT NULL AND request_hash IS NOT NULL) OR (type<>'comment' AND body IS NULL)),
        FOREIGN KEY (issue_id,actor_user_id) REFERENCES issue_participants(issue_id,user_id) ON DELETE CASCADE,
        UNIQUE (actor_user_id,request_key)
      );
      CREATE UNIQUE INDEX issue_entries_official_request ON issue_entries(request_key) WHERE actor_kind='official';
      CREATE INDEX issue_entries_timeline ON issue_entries(issue_id,id);
      CREATE INDEX issue_entries_author_created ON issue_entries(actor_user_id,created_at DESC);
      CREATE TABLE issue_user_moderation (
        user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        muted boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `);
  },
};
