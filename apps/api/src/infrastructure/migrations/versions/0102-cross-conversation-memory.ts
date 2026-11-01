import type { DatabaseMigration } from '#infrastructure/migrations/types';
import { DEFAULT_MEMORY_RUNTIME_POLICY } from '@fateclaw/contracts/memory';

export const crossConversationMemoryMigration: DatabaseMigration = {
  id: '0102_cross_conversation_memory',
  description:
    'Add scoped, evidence-backed cross-conversation memory and durable learning',
  async up(client) {
    await client.query(`
      ALTER TABLE runtime_config ADD COLUMN memory_policy jsonb NOT NULL DEFAULT '${JSON.stringify(DEFAULT_MEMORY_RUNTIME_POLICY)}'::jsonb;
      ALTER TABLE agent_requests ADD COLUMN memory_scope jsonb;
      ALTER TABLE chat_sessions ADD COLUMN memory_context_generation integer NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN created_actor_key text;
      ALTER TABLE chat_sessions ADD COLUMN created_actor_title text;
      ALTER TABLE chat_sessions ADD COLUMN memory_learning_enabled boolean NOT NULL DEFAULT true;
      ALTER TABLE chat_sessions ADD COLUMN memory_learning_revision integer NOT NULL DEFAULT 1;
      CREATE TABLE pi_session_contexts(
        session_id text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        context_audience text NOT NULL DEFAULT '',
        context_generation integer NOT NULL,
        reset_revision integer NOT NULL DEFAULT 0,
        initialized boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(session_id,context_audience)
      );
      UPDATE users u SET soul_content=legacy.soul_content FROM (
        SELECT DISTINCT ON(owner_id) owner_id,soul_content FROM accounts
        WHERE owner_id IS NOT NULL ORDER BY owner_id,enabled DESC,created_at ASC
      ) legacy WHERE legacy.owner_id=u.id AND btrim(u.soul_content)=''
        AND legacy.soul_content IS NOT NULL AND btrim(legacy.soul_content)<>'';
      CREATE TABLE memory_scopes (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_scope_id text REFERENCES memory_scopes(id) ON DELETE CASCADE,
        actor_key text NOT NULL,
        audience_key text NOT NULL,
        display_name text,
        bound_subject_id text,
        share_subject_memory boolean NOT NULL DEFAULT false,
        binding_revision integer NOT NULL DEFAULT 1,
        epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
        revision integer NOT NULL DEFAULT 1,
        learning_enabled boolean NOT NULL DEFAULT false,
        recall_enabled boolean NOT NULL DEFAULT true,
        chat_editing_enabled boolean NOT NULL DEFAULT true,
        cleared_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(owner_user_id,actor_key,audience_key)
      );
      CREATE INDEX memory_scopes_parent ON memory_scopes(parent_scope_id) WHERE parent_scope_id IS NOT NULL;
      INSERT INTO memory_scopes(owner_user_id,actor_key,audience_key,learning_enabled)
        SELECT id,'user:'||id,'owner:'||id,false FROM users;

      CREATE TABLE memory_entities (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id text NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK(kind IN ('self','client','sender','unresolved')),
        client_id text REFERENCES client_profiles(id) ON DELETE CASCADE,
        name text NOT NULL,
        aliases jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        deleted_at timestamptz
      );
      CREATE INDEX memory_entities_owner ON memory_entities(owner_user_id,kind) WHERE deleted_at IS NULL;
      CREATE INDEX memory_entities_client ON memory_entities(client_id) WHERE client_id IS NOT NULL;
      -- Plain indexes on cascade columns: a partial or non-leading index cannot serve the
      -- per-parent cascade lookup, which then scans the whole child table.
      CREATE INDEX memory_entities_scope ON memory_entities(scope_id);

      CREATE TABLE memory_sources (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id text NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
        memory_space_id text REFERENCES memory_scopes(id) ON DELETE CASCADE,
        subject_id text NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        source_kind text NOT NULL CHECK(source_kind IN ('message','profile','manual')),
        source_role text NOT NULL CHECK(source_role IN ('user','assistant','profile','manual')),
        source_ref text NOT NULL,
        manual_content text,
        account_id text,
        message_id text,
        session_id text REFERENCES chat_sessions(id) ON DELETE CASCADE,
        revision integer NOT NULL DEFAULT 1,
        content_hash text NOT NULL,
        source_sequence bigserial UNIQUE,
        observed_at timestamptz NOT NULL,
        epoch integer NOT NULL,
        learning_enabled boolean NOT NULL,
        identity_snapshot jsonb NOT NULL DEFAULT '{}',
        excluded_at timestamptz,
        extracted_revision integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(message_id,account_id) REFERENCES messages(id,account_id) ON DELETE CASCADE,
        UNIQUE(scope_id,source_kind,source_ref,revision)
      );
      CREATE INDEX memory_sources_scope_sequence ON memory_sources(scope_id,subject_id,source_sequence DESC) WHERE excluded_at IS NULL;
      CREATE INDEX memory_sources_message ON memory_sources(message_id,account_id) WHERE message_id IS NOT NULL;
      CREATE INDEX memory_sources_owner_ref ON memory_sources(owner_user_id,source_ref);
      CREATE INDEX memory_sources_session ON memory_sources(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX memory_sources_subject ON memory_sources(subject_id);
      CREATE INDEX memory_sources_space ON memory_sources(memory_space_id) WHERE memory_space_id IS NOT NULL;

      CREATE TABLE memory_items (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        family_id text NOT NULL,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id text NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
        subject_id text NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK(kind IN ('fact','preference','event','plan','decision')),
        assertion_type text NOT NULL CHECK(assertion_type IN ('stated','experience','plan','inferred')),
        content text NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
        content_hash text NOT NULL,
        fact_key text,
        status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','disputed','forgotten')),
        origin text NOT NULL CHECK(origin IN ('automatic','explicit','manual')),
        revision integer NOT NULL DEFAULT 1,
        epoch integer NOT NULL,
        source_sequence bigint NOT NULL DEFAULT 0,
        observed_at timestamptz NOT NULL,
        valid_from timestamptz,
        valid_to timestamptz,
        supersedes_id text REFERENCES memory_items(id) ON DELETE SET NULL,
        merged_into_id text REFERENCES memory_items(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(family_id,revision)
      );
      CREATE INDEX memory_items_scope ON memory_items(scope_id,subject_id,observed_at DESC);
      CREATE INDEX memory_items_subject ON memory_items(subject_id);
      CREATE INDEX memory_items_owner ON memory_items(owner_user_id,updated_at DESC,id);
      CREATE INDEX memory_items_merged_into ON memory_items(merged_into_id) WHERE merged_into_id IS NOT NULL;
      CREATE INDEX memory_items_supersedes ON memory_items(supersedes_id) WHERE supersedes_id IS NOT NULL;
      CREATE UNIQUE INDEX memory_items_active_hash ON memory_items(scope_id,subject_id,content_hash) WHERE status='active';
      CREATE INDEX memory_items_active_fact ON memory_items(scope_id,subject_id,fact_key) WHERE status='active' AND fact_key IS NOT NULL;

      CREATE TABLE memory_evidence (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        item_id text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        source_id text NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
        source_revision integer NOT NULL,
        source_hash text NOT NULL,
        quote text NOT NULL,
        quote_start integer,
        quote_end integer,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        revoked_at timestamptz,
        -- The range identifies the quote; indexing the text itself would cap quote length and
        -- collide once revocation blanks it.
        UNIQUE NULLS NOT DISTINCT(item_id,source_id,source_revision,quote_start,quote_end)
      );
      CREATE INDEX memory_evidence_source ON memory_evidence(source_id);

      CREATE TABLE memory_index_entries (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id text NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
        subject_id text NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        object_kind text NOT NULL CHECK(object_kind IN ('item','source')),
        object_id text NOT NULL,
        object_revision integer NOT NULL,
        chunk_start integer NOT NULL DEFAULT 0,
        chunk_end integer,
        search_text text NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(object_kind,object_id,object_revision,chunk_start)
      );
      CREATE INDEX memory_index_scope ON memory_index_entries(scope_id,subject_id,object_kind);
      CREATE INDEX memory_index_owner ON memory_index_entries(owner_user_id);
      CREATE INDEX memory_index_subject ON memory_index_entries(subject_id);

      CREATE TABLE memory_jobs (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id text NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
        subject_id text REFERENCES memory_entities(id) ON DELETE CASCADE,
        source_id text REFERENCES memory_sources(id) ON DELETE SET NULL,
        source_revision integer,
        request_id text,
        job_key text NOT NULL UNIQUE,
        kind text NOT NULL CHECK(kind IN ('extract','backfill')),
        event_type text NOT NULL,
        epoch integer NOT NULL,
        state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','failed','skipped','cancelled','paused')),
        payload jsonb NOT NULL DEFAULT '{}',
        attempts integer NOT NULL DEFAULT 0,
        lease_token text,
        lease_until timestamptz,
        next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        processed_count integer NOT NULL DEFAULT 0,
        total_count integer,
        error_code text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX memory_jobs_claim ON memory_jobs(next_attempt_at,created_at) WHERE state IN ('pending','running');
      CREATE INDEX memory_jobs_owner ON memory_jobs(owner_user_id,created_at DESC);
      CREATE INDEX memory_jobs_source ON memory_jobs(source_id) WHERE source_id IS NOT NULL;
      CREATE INDEX memory_jobs_finished ON memory_jobs(updated_at) WHERE state IN ('succeeded','skipped','cancelled');
      CREATE INDEX memory_jobs_scope ON memory_jobs(scope_id);
      CREATE INDEX memory_jobs_subject ON memory_jobs(subject_id) WHERE subject_id IS NOT NULL;

      CREATE TABLE memory_exclusions (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id text NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
        subject_id text REFERENCES memory_entities(id) ON DELETE CASCADE,
        source_id text REFERENCES memory_sources(id) ON DELETE SET NULL,
        source_ref text,
        source_hash text,
        family_id text,
        fact_key text,
        content_hash text,
        quote_start integer,
        quote_end integer,
        cutoff_sequence bigint NOT NULL,
        cutoff_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        persistent boolean NOT NULL DEFAULT false,
        reason text NOT NULL DEFAULT 'user_request',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX memory_exclusions_scope ON memory_exclusions(scope_id,subject_id);
      CREATE INDEX memory_exclusions_source ON memory_exclusions(source_id) WHERE source_id IS NOT NULL;
      CREATE INDEX memory_exclusions_source_ref ON memory_exclusions(owner_user_id,source_ref) WHERE source_ref IS NOT NULL;
      CREATE INDEX memory_exclusions_subject ON memory_exclusions(subject_id) WHERE subject_id IS NOT NULL;

      CREATE TABLE memory_tool_results (
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id text NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
        request_id text NOT NULL,
        tool_call_id text NOT NULL,
        operation_hash text NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(request_id,tool_call_id)
      );

      CREATE TABLE memory_usage (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        job_id text REFERENCES memory_jobs(id) ON DELETE SET NULL,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose text NOT NULL,
        model_config_id text NOT NULL,
        model text NOT NULL,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        usage_known boolean NOT NULL DEFAULT true,
        duration_ms integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX memory_usage_job ON memory_usage(job_id) WHERE job_id IS NOT NULL;
      CREATE INDEX memory_usage_created ON memory_usage(created_at);
      CREATE TABLE memory_daily_budgets (
        day date NOT NULL,
        purpose text NOT NULL,
        reserved_tokens bigint NOT NULL DEFAULT 0,
        used_tokens bigint NOT NULL DEFAULT 0,
        calls integer NOT NULL DEFAULT 0,
        PRIMARY KEY(day,purpose)
      );
      CREATE TABLE memory_budget_reservations (
        id text PRIMARY KEY,
        job_id text REFERENCES memory_jobs(id) ON DELETE SET NULL,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lease_token text,
        day date NOT NULL,
        purpose text NOT NULL,
        reserved_tokens bigint NOT NULL,
        deadline_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '5 minutes'),
        state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','settled')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        settled_at timestamptz,
        FOREIGN KEY(day,purpose) REFERENCES memory_daily_budgets(day,purpose)
      );
      CREATE INDEX memory_budget_job ON memory_budget_reservations(job_id) WHERE job_id IS NOT NULL;
      CREATE INDEX memory_budget_deadline ON memory_budget_reservations(deadline_at,id) WHERE state='pending';

      -- Bulk callers set fateclaw.memory_bulk and run reconcileRemovedMemorySources once, because
      -- these per-row triggers cost several statements for every removed message.
      CREATE FUNCTION memory_revoke_source_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE affected_ids text[];
      BEGIN
        IF current_setting('fateclaw.memory_bulk',true)='on'
          OR NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_user_id) THEN
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        SELECT array_agg(item_id) INTO affected_ids FROM memory_evidence WHERE source_id=OLD.id AND revoked_at IS NULL;
        UPDATE memory_evidence SET revoked_at=clock_timestamp(),quote='' WHERE source_id=OLD.id AND revoked_at IS NULL;
        UPDATE memory_items i SET status='forgotten',content='[来源已撤销]',updated_at=clock_timestamp()
          WHERE i.id=ANY(COALESCE(affected_ids,ARRAY[]::text[]))
            AND NOT EXISTS(SELECT 1 FROM memory_evidence e WHERE e.item_id=i.id AND e.revoked_at IS NULL);
        DELETE FROM memory_index_entries x WHERE (x.object_kind='source' AND x.object_id=OLD.id)
          OR (x.object_kind='item' AND x.object_id=ANY(COALESCE(affected_ids,ARRAY[]::text[]))
            AND EXISTS(SELECT 1 FROM memory_items i WHERE i.id=x.object_id AND i.status='forgotten'));
        UPDATE memory_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,error_code='SOURCE_REVOKED',updated_at=clock_timestamp()
          WHERE source_id=OLD.id AND state IN ('pending','running','paused');
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER memory_source_removed BEFORE DELETE ON memory_sources
        FOR EACH ROW EXECUTE FUNCTION memory_revoke_source_dependencies();
      CREATE TRIGGER memory_source_excluded AFTER UPDATE OF excluded_at ON memory_sources
        FOR EACH ROW WHEN(OLD.excluded_at IS NULL AND NEW.excluded_at IS NOT NULL)
        EXECUTE FUNCTION memory_revoke_source_dependencies();
      CREATE FUNCTION memory_message_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('fateclaw.memory_bulk',true)='on' THEN RETURN NEW; END IF;
        UPDATE memory_sources SET excluded_at=clock_timestamp()
          WHERE message_id=OLD.id AND account_id=OLD.account_id AND excluded_at IS NULL;
        RETURN NEW;
      END $$;
      CREATE TRIGGER memory_message_changed AFTER UPDATE OF content,deleted_at ON messages
        FOR EACH ROW WHEN(OLD.content IS DISTINCT FROM NEW.content OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL))
        EXECUTE FUNCTION memory_message_source_changed();

    `);
  },
};
