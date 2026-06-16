import type { DatabaseMigration } from '../types.js';
import { ensureCheckConstraint } from '../helpers.js';

/**
 * 数据库迁移分段：0020-0036。
 */
export const runtimeSkillMigrations: readonly DatabaseMigration[] = [
  {
    id: '0020_runtime_config',
    description: '增加 Agent 运行时后台配置',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS runtime_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          agent_concurrency_limit INTEGER NOT NULL DEFAULT 10,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO runtime_config (id)
        VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_agent_concurrency_limit_positive',
        tableName: 'runtime_config',
        expression: 'agent_concurrency_limit > 0',
        cleanupSql: `UPDATE runtime_config
                     SET agent_concurrency_limit = 10
                     WHERE agent_concurrency_limit <= 0`,
      });
    },
  },
  {
    id: '0021_wechat_chat_session_links',
    description: '增加微信 sender 与网页 AI Chat 会话接续映射',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS wechat_chat_session_links (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          sender_hash TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (account_id, sender_hash)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wechat_session_links_user_updated
          ON wechat_chat_session_links(user_id, updated_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wechat_session_links_session
          ON wechat_chat_session_links(session_id)
      `);
    },
  },
  {
    id: '0022_drop_scheduled_tasks',
    description: '下线定时任务与运行日志表',
    async up(client) {
      await client.query(`DROP TABLE IF EXISTS task_run_logs`);
      await client.query(`DROP TABLE IF EXISTS scheduled_tasks`);
    },
  },
  {
    id: '0023_skill_access_invites',
    description: '增加 Skill 私密授权链接 schema',
    async up(client) {
      await client.query(
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'share'`,
      );
      await client.query(`DO $$
        BEGIN
          IF to_regclass('public.user_skill_subscription_bundle_sources') IS NOT NULL THEN
            UPDATE user_skill_subscriptions sub
            SET source_kind = 'bundle_share'
            WHERE sub.has_direct_source = false
              AND sub.source_kind = 'share'
              AND EXISTS (
                SELECT 1
                FROM user_skill_subscription_bundle_sources src
                WHERE src.subscription_id = sub.id
              );
          END IF;
        END $$;`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_access_invites (
          id TEXT PRIMARY KEY,
          creator_id TEXT NOT NULL REFERENCES users(id),
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          max_redemptions INTEGER NOT NULL DEFAULT 1,
          redeemed_count INTEGER NOT NULL DEFAULT 0,
          expires_at TIMESTAMPTZ DEFAULT NULL,
          revoked_at TIMESTAMPTZ DEFAULT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_access_invites_creator_target
         ON skill_access_invites(creator_id, target_type, target_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_access_invites_token
         ON skill_access_invites(token)`,
      );
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_skill_subscriptions_source_kind_valid',
        tableName: 'user_skill_subscriptions',
        expression: `source_kind IN ('share', 'bundle_share', 'invite', 'bundle_invite')`,
        cleanupSql: `UPDATE user_skill_subscriptions
                     SET source_kind = 'share'
                     WHERE source_kind NOT IN ('share', 'bundle_share', 'invite', 'bundle_invite')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_skill_access_invites_target_type_valid',
        tableName: 'skill_access_invites',
        expression: `target_type IN ('skill', 'bundle')`,
        cleanupSql: `UPDATE skill_access_invites
                     SET target_type = 'skill'
                     WHERE target_type NOT IN ('skill', 'bundle')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_skill_access_invites_redemptions_valid',
        tableName: 'skill_access_invites',
        expression: `max_redemptions > 0 AND redeemed_count >= 0 AND redeemed_count <= max_redemptions`,
        cleanupSql: `UPDATE skill_access_invites
                     SET max_redemptions = GREATEST(1, max_redemptions),
                         redeemed_count = LEAST(GREATEST(0, redeemed_count), GREATEST(1, max_redemptions))`,
      });
    },
  },
  {
    id: '0024_user_model_thinking_level',
    description: '增加用户模型选择的 Pi 思考等级偏好',
    async up(client) {
      await client.query(
        `ALTER TABLE user_model_selections
         ADD COLUMN IF NOT EXISTS thinking_level TEXT NOT NULL DEFAULT 'medium'`,
      );
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_model_selections_thinking_level_valid',
        tableName: 'user_model_selections',
        expression: `thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`,
        cleanupSql: `UPDATE user_model_selections
                     SET thinking_level = 'medium'
                     WHERE thinking_level NOT IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`,
      });
    },
  },
  {
    id: '0025_local_agent_runtime_limits',
    description: '增加本地 agent-runtime 常驻进程上限与空闲回收配置',
    async up(client) {
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS local_agent_max_processes INTEGER NOT NULL DEFAULT 4,
          ADD COLUMN IF NOT EXISTS local_agent_idle_ttl_ms INTEGER NOT NULL DEFAULT 600000
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_local_agent_max_processes_range',
        tableName: 'runtime_config',
        expression: 'local_agent_max_processes BETWEEN 1 AND 100',
        cleanupSql: `UPDATE runtime_config
                     SET local_agent_max_processes = LEAST(GREATEST(local_agent_max_processes, 1), 100)
                     WHERE local_agent_max_processes < 1 OR local_agent_max_processes > 100`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_local_agent_idle_ttl_ms_range',
        tableName: 'runtime_config',
        expression: 'local_agent_idle_ttl_ms BETWEEN 30000 AND 86400000',
        cleanupSql: `UPDATE runtime_config
                     SET local_agent_idle_ttl_ms = LEAST(GREATEST(local_agent_idle_ttl_ms, 30000), 86400000)
                     WHERE local_agent_idle_ttl_ms < 30000 OR local_agent_idle_ttl_ms > 86400000`,
      });
    },
  },
  {
    id: '0026_pi_session_health_runtime_config',
    description: '增加 Pi session 健康维护后台配置',
    async up(client) {
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS pi_session_health_enabled BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS pi_session_inactive_cleanup_days INTEGER NOT NULL DEFAULT 30,
          ADD COLUMN IF NOT EXISTS pi_session_orphan_grace_days INTEGER NOT NULL DEFAULT 30
      `);
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_runtime_config_pi_session_inactive_cleanup_days_range',
        tableName: 'runtime_config',
        expression: 'pi_session_inactive_cleanup_days BETWEEN 1 AND 3650',
        cleanupSql: `UPDATE runtime_config
                     SET pi_session_inactive_cleanup_days = LEAST(GREATEST(pi_session_inactive_cleanup_days, 1), 3650)
                     WHERE pi_session_inactive_cleanup_days < 1 OR pi_session_inactive_cleanup_days > 3650`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_pi_session_orphan_grace_days_range',
        tableName: 'runtime_config',
        expression: 'pi_session_orphan_grace_days BETWEEN 1 AND 3650',
        cleanupSql: `UPDATE runtime_config
                     SET pi_session_orphan_grace_days = LEAST(GREATEST(pi_session_orphan_grace_days, 1), 3650)
                     WHERE pi_session_orphan_grace_days < 1 OR pi_session_orphan_grace_days > 3650`,
      });
    },
  },
  {
    id: '0027_user_auth_token_version',
    description: '增加用户认证 token 版本以支持改密后旧 JWT 失效',
    async up(client) {
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS auth_token_version INTEGER NOT NULL DEFAULT 0
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_users_auth_token_version_nonnegative',
        tableName: 'users',
        expression: 'auth_token_version >= 0',
        cleanupSql: `UPDATE users
                     SET auth_token_version = 0
                     WHERE auth_token_version < 0`,
      });
    },
  },
  {
    id: '0028_skill_bundle_runtime_limits',
    description: '增加用户 Skill Bundle 文件限制后台配置',
    async up(client) {
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS skill_bundle_max_files INTEGER NOT NULL DEFAULT 50,
          ADD COLUMN IF NOT EXISTS skill_bundle_max_file_chars INTEGER NOT NULL DEFAULT 100000,
          ADD COLUMN IF NOT EXISTS skill_bundle_max_total_chars INTEGER NOT NULL DEFAULT 500000,
          ADD COLUMN IF NOT EXISTS skill_bundle_max_zip_bytes INTEGER NOT NULL DEFAULT 8388608
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_files_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_files BETWEEN 1 AND 500',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_files = LEAST(GREATEST(skill_bundle_max_files, 1), 500)
                     WHERE skill_bundle_max_files < 1 OR skill_bundle_max_files > 500`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_file_chars_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_file_chars BETWEEN 1 AND 2000000',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_file_chars = LEAST(GREATEST(skill_bundle_max_file_chars, 1), 2000000)
                     WHERE skill_bundle_max_file_chars < 1 OR skill_bundle_max_file_chars > 2000000`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_total_chars_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_total_chars BETWEEN 1 AND 10000000',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_total_chars = LEAST(GREATEST(skill_bundle_max_total_chars, 1), 10000000)
                     WHERE skill_bundle_max_total_chars < 1 OR skill_bundle_max_total_chars > 10000000`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_runtime_config_skill_bundle_total_chars_at_least_file_chars',
        tableName: 'runtime_config',
        expression:
          'skill_bundle_max_total_chars >= skill_bundle_max_file_chars',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_total_chars = skill_bundle_max_file_chars
                     WHERE skill_bundle_max_total_chars < skill_bundle_max_file_chars`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_skill_bundle_max_zip_bytes_range',
        tableName: 'runtime_config',
        expression: 'skill_bundle_max_zip_bytes BETWEEN 1024 AND 104857600',
        cleanupSql: `UPDATE runtime_config
                     SET skill_bundle_max_zip_bytes = LEAST(GREATEST(skill_bundle_max_zip_bytes, 1024), 104857600)
                     WHERE skill_bundle_max_zip_bytes < 1024 OR skill_bundle_max_zip_bytes > 104857600`,
      });
    },
  },
  {
    id: '0029_simple_workflow_presets',
    description: '增加简易模式 Workflow preset 配置',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS simple_workflow_presets (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          is_default BOOLEAN NOT NULL DEFAULT false,
          entry_title TEXT NOT NULL,
          entry_description TEXT NOT NULL DEFAULT '',
          paipan_skill TEXT NOT NULL,
          paipan_input_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
          model_policy JSONB NOT NULL DEFAULT '{"mode":"system-default"}'::jsonb,
          skill_bundle_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          skill_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          skill_snapshot_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          prompt_template TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_simple_workflow_presets_kind_valid',
        tableName: 'simple_workflow_presets',
        expression: `kind IN ('divination', 'natal')`,
        cleanupSql: `UPDATE simple_workflow_presets
                     SET kind = 'divination'
                     WHERE kind NOT IN ('divination', 'natal')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_simple_workflow_presets_paipan_skill_valid',
        tableName: 'simple_workflow_presets',
        expression: `paipan_skill IN ('iching-paipan', 'bazi-paipan')`,
        cleanupSql: `UPDATE simple_workflow_presets
                     SET paipan_skill = CASE
                       WHEN kind = 'natal' THEN 'bazi-paipan'
                       ELSE 'iching-paipan'
                     END
                     WHERE paipan_skill NOT IN ('iching-paipan', 'bazi-paipan')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_simple_workflow_presets_kind_skill_match',
        tableName: 'simple_workflow_presets',
        expression: `(kind = 'divination' AND paipan_skill = 'iching-paipan')
                     OR (kind = 'natal' AND paipan_skill = 'bazi-paipan')`,
        cleanupSql: `UPDATE simple_workflow_presets
                     SET paipan_skill = CASE
                       WHEN kind = 'natal' THEN 'bazi-paipan'
                       ELSE 'iching-paipan'
                     END`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_simple_workflow_presets_model_policy_object',
        tableName: 'simple_workflow_presets',
        expression: `jsonb_typeof(model_policy) = 'object'
                     AND model_policy ? 'mode'
                     AND model_policy->>'mode' IN ('system-default', 'user-current', 'fixed')`,
        cleanupSql: `UPDATE simple_workflow_presets
                     SET model_policy = '{"mode":"system-default"}'::jsonb
                     WHERE jsonb_typeof(model_policy) <> 'object'
                        OR NOT (model_policy ? 'mode')
                        OR model_policy->>'mode' NOT IN ('system-default', 'user-current', 'fixed')`,
      });
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_simple_workflow_presets_kind_default
          ON simple_workflow_presets(kind)
          WHERE enabled = true AND is_default = true
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_simple_workflow_presets_kind_sort
          ON simple_workflow_presets(kind, sort_order, id)
      `);
      await client.query(
        `INSERT INTO simple_workflow_presets (
           id, kind, name, enabled, is_default, entry_title, entry_description,
           paipan_skill, paipan_input_defaults, model_policy, skill_bundle_ids,
           prompt_template, sort_order
         )
         VALUES
           (
             'simple-divination-default',
             'divination',
             '默认占卜问事',
             true,
             true,
             '占卜问事',
             '适合近期选择、关系走向、工作决策和单件事情。',
             'iching-paipan',
             '{"method":"dayan"}'::jsonb,
             '{"mode":"user-current","thinkingLevel":"medium"}'::jsonb,
             ARRAY[]::TEXT[],
             '结合用户问题、背景补充和六爻盘面，用新手能理解的方式给出判断。',
             10
           ),
           (
             'simple-natal-default',
             'natal',
             '默认命理分析',
             true,
             true,
             '命理分析',
             '适合长期性格、事业方向、关系模式和人生阶段。',
             'bazi-paipan',
             '{"include":["bazi","fortune","pattern"]}'::jsonb,
             '{"mode":"system-default","thinkingLevel":"medium"}'::jsonb,
             ARRAY[]::TEXT[],
             '结合用户问题方向和八字盘面，给出结构化命理分析。',
             20
           )
         ON CONFLICT (id) DO NOTHING`,
      );
    },
  },
  {
    id: '0030_user_referrals',
    description: '增加用户邀请会员返利 schema',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS referral_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          enabled BOOLEAN NOT NULL DEFAULT true,
          inviter_reward_days INTEGER NOT NULL DEFAULT 7,
          monthly_reward_cap_days INTEGER NOT NULL DEFAULT 30,
          reward_first_membership_only BOOLEAN NOT NULL DEFAULT true,
          invite_count_reward_threshold INTEGER NOT NULL DEFAULT 10,
          invite_count_reward_days INTEGER NOT NULL DEFAULT 7,
          invite_count_reward_max_invites INTEGER NOT NULL DEFAULT 50,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO referral_config (id)
        VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_invite_codes (
          id TEXT PRIMARY KEY,
          inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code TEXT NOT NULL UNIQUE,
          max_redemptions INTEGER NOT NULL DEFAULT 1000000,
          redeemed_count INTEGER NOT NULL DEFAULT 0,
          expires_at TIMESTAMPTZ DEFAULT NULL,
          revoked_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invite_codes_inviter
          ON user_invite_codes(inviter_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_invite_codes_code
          ON user_invite_codes(code)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_referrals (
          id TEXT PRIMARY KEY,
          invite_code_id TEXT NOT NULL REFERENCES user_invite_codes(id),
          inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          bind_source TEXT NOT NULL DEFAULT 'redeem',
          reward_status TEXT NOT NULL DEFAULT 'pending',
          reward_days INTEGER NOT NULL DEFAULT 0,
          reward_event_id TEXT DEFAULT NULL,
          rewarded_at TIMESTAMPTZ DEFAULT NULL,
          skip_reason TEXT DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (invitee_id)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_referrals_inviter_created
          ON user_referrals(inviter_id, created_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_referrals_reward_status
          ON user_referrals(reward_status, created_at DESC)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS referral_reward_events (
          id TEXT PRIMARY KEY,
          referral_id TEXT NOT NULL REFERENCES user_referrals(id) ON DELETE CASCADE,
          inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          reward_days INTEGER NOT NULL DEFAULT 0,
          trigger_wallet_transaction_id TEXT DEFAULT NULL,
          status TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_reward_events_referral_reason_granted
          ON referral_reward_events(referral_id, reason)
          WHERE status = 'granted'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_referral_reward_events_inviter_created
          ON referral_reward_events(inviter_id, created_at DESC)
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_referral_config_reward_days_valid',
        tableName: 'referral_config',
        expression:
          'inviter_reward_days >= 0 AND inviter_reward_days <= 366 AND monthly_reward_cap_days >= 0 AND monthly_reward_cap_days <= 3660',
        cleanupSql: `UPDATE referral_config
                     SET inviter_reward_days = LEAST(GREATEST(inviter_reward_days, 0), 366),
                         monthly_reward_cap_days = LEAST(GREATEST(monthly_reward_cap_days, 0), 3660)`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_invite_codes_redemptions_valid',
        tableName: 'user_invite_codes',
        expression:
          'max_redemptions > 0 AND redeemed_count >= 0 AND redeemed_count <= max_redemptions',
        cleanupSql: `UPDATE user_invite_codes
                     SET max_redemptions = GREATEST(1, max_redemptions),
                         redeemed_count = LEAST(GREATEST(0, redeemed_count), GREATEST(1, max_redemptions))`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_referrals_no_self',
        tableName: 'user_referrals',
        expression: 'inviter_id <> invitee_id',
        cleanupSql: `DELETE FROM user_referrals WHERE inviter_id = invitee_id`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_referrals_bind_source_valid',
        tableName: 'user_referrals',
        expression: `bind_source IN ('register', 'redeem')`,
        cleanupSql: `UPDATE user_referrals
                     SET bind_source = 'redeem'
                     WHERE bind_source NOT IN ('register', 'redeem')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_referrals_reward_status_valid',
        tableName: 'user_referrals',
        expression: `reward_status IN ('pending', 'granted', 'skipped', 'ineligible')`,
        cleanupSql: `UPDATE user_referrals
                     SET reward_status = 'pending'
                     WHERE reward_status NOT IN ('pending', 'granted', 'skipped', 'ineligible')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_referral_reward_events_status_valid',
        tableName: 'referral_reward_events',
        expression: `status IN ('granted', 'skipped', 'ineligible')`,
        cleanupSql: `UPDATE referral_reward_events
                     SET status = 'skipped'
                     WHERE status NOT IN ('granted', 'skipped', 'ineligible')`,
      });
    },
  },

  {
    id: '0031_default_official_model_runtime_config',
    description: '增加后台系统默认官方模型配置',
    async up(client) {
      // 为 runtime_config 增加后台系统默认官方模型列，缺省 NULL 表示沿用最低价兜底。
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS default_official_model_id TEXT DEFAULT NULL
      `);
      // 老库可能没有外键，使用 DO 块在缺失时补建，ON DELETE SET NULL 让管理员删默认模型不会破坏配置。
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'fk_runtime_config_default_official_model'
          ) THEN
            ALTER TABLE runtime_config
              ADD CONSTRAINT fk_runtime_config_default_official_model
              FOREIGN KEY (default_official_model_id)
              REFERENCES official_model_configs(id)
              ON DELETE SET NULL
              ON UPDATE CASCADE;
          END IF;
        END $$
      `);
    },
  },
  {
    id: '0032_default_thinking_level_runtime_config',
    description: '增加后台默认思考等级配置',
    async up(client) {
      // 新增后台默认思考等级，只影响没有用户模型选择记录的新用户兜底。
      await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS default_thinking_level TEXT NOT NULL DEFAULT 'medium'
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_runtime_config_default_thinking_level_valid',
        tableName: 'runtime_config',
        expression: `default_thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`,
        cleanupSql: `UPDATE runtime_config
                     SET default_thinking_level = 'medium'
                     WHERE default_thinking_level NOT IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh')`,
      });
    },
  },
  {
    id: '0033_referral_invite_count_reward',
    description: '增加累计邀请人数会员奖励配置',
    async up(client) {
      await client.query(`
        ALTER TABLE referral_config
          ADD COLUMN IF NOT EXISTS invite_count_reward_threshold INTEGER NOT NULL DEFAULT 10,
          ADD COLUMN IF NOT EXISTS invite_count_reward_days INTEGER NOT NULL DEFAULT 7,
          ADD COLUMN IF NOT EXISTS invite_count_reward_max_invites INTEGER NOT NULL DEFAULT 50
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_referral_config_invite_count_reward_valid',
        tableName: 'referral_config',
        expression:
          'invite_count_reward_threshold >= 0 AND invite_count_reward_threshold <= 1000000 AND invite_count_reward_days >= 0 AND invite_count_reward_days <= 366 AND invite_count_reward_max_invites >= 0 AND invite_count_reward_max_invites <= 1000000',
        cleanupSql: `UPDATE referral_config
                     SET invite_count_reward_threshold = LEAST(GREATEST(invite_count_reward_threshold, 0), 1000000),
                         invite_count_reward_days = LEAST(GREATEST(invite_count_reward_days, 0), 366),
                         invite_count_reward_max_invites = LEAST(GREATEST(invite_count_reward_max_invites, 0), 1000000)`,
      });
      // 计数奖励和首购奖励可能由同一个邀请关系触发，唯一键需要按奖励原因隔离。
      await client.query(`
        DROP INDEX IF EXISTS idx_referral_reward_events_referral_granted
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_reward_events_referral_reason_granted
          ON referral_reward_events(referral_id, reason)
          WHERE status = 'granted'
      `);
    },
  },
  {
    id: '0034_announcements',
    description: '增加运营公告系统 schema',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS announcements (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          body_markdown TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          priority INTEGER NOT NULL DEFAULT 0,
          starts_at TIMESTAMPTZ DEFAULT NULL,
          ends_at TIMESTAMPTZ DEFAULT NULL,
          cta_label TEXT DEFAULT NULL,
          cta_href TEXT DEFAULT NULL,
          published_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_announcements_status_valid',
        tableName: 'announcements',
        expression: `status IN ('draft', 'published', 'archived')`,
        cleanupSql: `UPDATE announcements
                     SET status = 'draft'
                     WHERE status NOT IN ('draft', 'published', 'archived')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_announcements_slug_format',
        tableName: 'announcements',
        expression: `char_length(slug) BETWEEN 1 AND 80 AND slug ~ '^[a-z0-9][a-z0-9-]*$'`,
        cleanupSql: `UPDATE announcements
                     SET slug = lower(regexp_replace(slug, '[^a-zA-Z0-9]+', '-', 'g'))
                     WHERE char_length(slug) = 0
                        OR char_length(slug) > 80
                        OR slug !~ '^[a-z0-9][a-z0-9-]*$'`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_announcements_content_lengths',
        tableName: 'announcements',
        expression:
          'char_length(title) BETWEEN 1 AND 120 AND char_length(summary) <= 280 AND char_length(body_markdown) BETWEEN 1 AND 20000 AND (cta_label IS NULL OR char_length(cta_label) BETWEEN 1 AND 40)',
        cleanupSql: `UPDATE announcements
                     SET title = left(COALESCE(NULLIF(title, ''), '公告'), 120),
                         summary = left(COALESCE(summary, ''), 280),
                         body_markdown = left(COALESCE(NULLIF(body_markdown, ''), title), 20000),
                         cta_label = CASE
                           WHEN cta_label IS NULL OR btrim(cta_label) = '' THEN NULL
                           ELSE left(cta_label, 40)
                         END`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_announcements_time_window',
        tableName: 'announcements',
        expression:
          'ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at',
        cleanupSql: `UPDATE announcements
                     SET ends_at = NULL
                     WHERE ends_at IS NOT NULL
                       AND starts_at IS NOT NULL
                       AND ends_at <= starts_at`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_announcements_cta_pair',
        tableName: 'announcements',
        expression:
          '(cta_label IS NULL AND cta_href IS NULL) OR (cta_label IS NOT NULL AND cta_href IS NOT NULL)',
        cleanupSql: `UPDATE announcements
                     SET cta_label = NULL,
                         cta_href = NULL
                     WHERE (cta_label IS NULL AND cta_href IS NOT NULL)
                        OR (cta_label IS NOT NULL AND cta_href IS NULL)`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_announcements_cta_href_safe',
        tableName: 'announcements',
        expression: `cta_href IS NULL OR (cta_href LIKE '/%' AND cta_href NOT LIKE '//%') OR cta_href LIKE 'https://%'`,
        cleanupSql: `UPDATE announcements
                     SET cta_label = NULL,
                         cta_href = NULL
                     WHERE cta_href IS NOT NULL
                       AND (cta_href NOT LIKE '/%' OR cta_href LIKE '//%')
                       AND cta_href NOT LIKE 'https://%'`,
      });
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_announcements_status_window_priority
          ON announcements (status, priority DESC, published_at DESC, updated_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_announcements_published_at
          ON announcements (published_at DESC, updated_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_announcements_updated_at
          ON announcements (updated_at DESC, created_at DESC)
      `);
    },
  },
  {
    id: '0035_simple_workflow_skill_snapshots',
    description: '为简易模式 Workflow 增加绑定 Skill 快照',
    async up(client) {
      await client.query(`
        ALTER TABLE simple_workflow_presets
          ADD COLUMN IF NOT EXISTS skill_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          ADD COLUMN IF NOT EXISTS skill_snapshot_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
      `);
    },
  },
  {
    id: '0036_repair_simple_workflow_skill_snapshot_columns',
    description: '修复简易模式 Workflow Skill 快照列缺失',
    async up(client) {
      await client.query(`
        ALTER TABLE simple_workflow_presets
          ADD COLUMN IF NOT EXISTS skill_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          ADD COLUMN IF NOT EXISTS skill_snapshot_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
      `);
    },
  },
  {
    id: '0037_membership_pro_plan',
    description: '增加 FateClaw Pro 会员套餐配置',
    async up(client) {
      await client.query(`
        ALTER TABLE membership_config
          ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'FateClaw Plus',
          ADD COLUMN IF NOT EXISTS display_price_coins NUMERIC(14,2) NOT NULL DEFAULT 30
      `);
      await client.query(`
        UPDATE membership_config
        SET name = CASE
              WHEN id = 'fateclaw_pro' THEN 'FateClaw Pro'
              ELSE 'FateClaw Plus'
            END,
            display_price_coins = CASE
              WHEN id = 'fateclaw_pro' THEN 120
              ELSE GREATEST(display_price_coins, monthly_price_coins)
            END
        WHERE name = 'FateClaw Plus'
           OR display_price_coins < monthly_price_coins
      `);
      await client.query(`
        INSERT INTO membership_config (
          id, enabled, name, monthly_price_coins, display_price_coins,
          monthly_allowance_units, standard_price_per_million_units_coins,
          updated_at
        )
        SELECT
          'fateclaw_pro',
          enabled,
          'FateClaw Pro',
          100,
          120,
          monthly_allowance_units,
          standard_price_per_million_units_coins,
          NOW()
        FROM membership_config
        WHERE id = 'default'
        ON CONFLICT (id) DO NOTHING
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_membership_config_display_price_nonnegative',
        tableName: 'membership_config',
        expression: 'display_price_coins >= 0',
        cleanupSql: `UPDATE membership_config
                     SET display_price_coins = GREATEST(monthly_price_coins, 0)
                     WHERE display_price_coins < 0`,
      });
    },
  },
  {
    id: '0038_membership_plan_timeline',
    description: '允许同一用户同时持有不同档位会员权益',
    async up(client) {
      await client.query(`
        DELETE FROM user_memberships a
        USING user_memberships b
        WHERE a.ctid < b.ctid
          AND a.user_id = b.user_id
          AND a.plan_key = b.plan_key
      `);
      await client.query(`
        ALTER TABLE user_memberships
          DROP CONSTRAINT IF EXISTS user_memberships_pkey
      `);
      await client.query(`
        ALTER TABLE user_memberships
          ADD CONSTRAINT user_memberships_pkey PRIMARY KEY (user_id, plan_key)
      `);
      await client.query(`
        DELETE FROM membership_allowances a
        USING membership_allowances b
        WHERE a.ctid < b.ctid
          AND a.user_id = b.user_id
          AND a.plan_key = b.plan_key
          AND a.period_start = b.period_start
      `);
      await client.query(`
        ALTER TABLE membership_allowances
          DROP CONSTRAINT IF EXISTS membership_allowances_user_id_period_start_key,
          DROP CONSTRAINT IF EXISTS membership_allowances_user_plan_period_key
      `);
      await client.query(`
        ALTER TABLE membership_allowances
          ADD CONSTRAINT membership_allowances_user_plan_period_key
            UNIQUE (user_id, plan_key, period_start)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_memberships_user_effective
          ON user_memberships(user_id, status, current_period_end DESC)
      `);
    },
  },
  {
    id: '0039_free_professional_ai_quota',
    description: '增加 Free 用户专业模式 AI 每日次数配置和用量表',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ai_chat_free_quota_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          daily_professional_turn_limit INTEGER NOT NULL DEFAULT 5,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO ai_chat_free_quota_config (id)
        VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ai_chat_free_daily_usage (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          usage_date TEXT NOT NULL,
          professional_turn_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, usage_date)
        )
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_ai_chat_free_quota_limit_range',
        tableName: 'ai_chat_free_quota_config',
        expression:
          'daily_professional_turn_limit >= 0 AND daily_professional_turn_limit <= 1000000',
        cleanupSql: `UPDATE ai_chat_free_quota_config
                     SET daily_professional_turn_limit = LEAST(
                       GREATEST(daily_professional_turn_limit, 0),
                       1000000
                     )`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_ai_chat_free_daily_usage_turn_count_nonnegative',
        tableName: 'ai_chat_free_daily_usage',
        expression: 'professional_turn_count >= 0',
        cleanupSql: `UPDATE ai_chat_free_daily_usage
                     SET professional_turn_count = GREATEST(
                       professional_turn_count,
                       0
                     )`,
      });
    },
  },
  {
    id: '0040_billing_gift_codes',
    description: '增加软妹币礼品码和兑换记录',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS gift_codes (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL DEFAULT '',
          balance_type TEXT NOT NULL,
          usage_type TEXT NOT NULL,
          amount_coins NUMERIC(14,2) NOT NULL,
          max_redemptions INTEGER NOT NULL DEFAULT 1,
          redeemed_count INTEGER NOT NULL DEFAULT 0,
          enabled BOOLEAN NOT NULL DEFAULT true,
          expires_at TIMESTAMPTZ DEFAULT NULL,
          created_by TEXT DEFAULT NULL,
          note TEXT DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS gift_code_redemptions (
          id TEXT PRIMARY KEY,
          gift_code_id TEXT NOT NULL REFERENCES gift_codes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          wallet_transaction_id TEXT DEFAULT NULL,
          balance_grant_id TEXT DEFAULT NULL,
          balance_type TEXT NOT NULL,
          amount_coins NUMERIC(14,2) NOT NULL,
          redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (gift_code_id, user_id)
        )
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_gift_codes_balance_type_valid',
        tableName: 'gift_codes',
        expression: `balance_type IN ('purchased', 'bonus')`,
        cleanupSql: `UPDATE gift_codes
                     SET balance_type = 'bonus'
                     WHERE balance_type NOT IN ('purchased', 'bonus')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_gift_codes_usage_type_valid',
        tableName: 'gift_codes',
        expression: `usage_type IN ('single', 'multi')`,
        cleanupSql: `UPDATE gift_codes
                     SET usage_type = 'single'
                     WHERE usage_type NOT IN ('single', 'multi')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_gift_codes_amount_positive',
        tableName: 'gift_codes',
        expression: 'amount_coins > 0',
        cleanupSql: `UPDATE gift_codes
                     SET amount_coins = 1
                     WHERE amount_coins <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_gift_codes_redemptions_valid',
        tableName: 'gift_codes',
        expression:
          'max_redemptions > 0 AND redeemed_count >= 0 AND redeemed_count <= max_redemptions',
        cleanupSql: `UPDATE gift_codes
                     SET max_redemptions = GREATEST(max_redemptions, 1),
                         redeemed_count = LEAST(GREATEST(redeemed_count, 0), GREATEST(max_redemptions, 1))`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_gift_code_redemptions_balance_type_valid',
        tableName: 'gift_code_redemptions',
        expression: `balance_type IN ('purchased', 'bonus')`,
        cleanupSql: `UPDATE gift_code_redemptions
                     SET balance_type = 'bonus'
                     WHERE balance_type NOT IN ('purchased', 'bonus')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_gift_code_redemptions_amount_positive',
        tableName: 'gift_code_redemptions',
        expression: 'amount_coins > 0',
        cleanupSql: `UPDATE gift_code_redemptions
                     SET amount_coins = 1
                     WHERE amount_coins <= 0`,
      });
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_gift_codes_created_at
          ON gift_codes(created_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_gift_codes_status_lookup
          ON gift_codes(enabled, expires_at, redeemed_count, max_redemptions)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_gift_redemptions_user_time
          ON gift_code_redemptions(user_id, redeemed_at DESC)
      `);
    },
  },
  {
    id: '0041_oauth_user_identities',
    description: '增加第三方登录身份并允许用户无手机号注册',
    async up(client) {
      await client.query(`
        ALTER TABLE users
          ALTER COLUMN phone DROP NOT NULL,
          ALTER COLUMN password_hash DROP NOT NULL
      `);
      await client.query(
        `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key`,
      );
      await client.query(`DROP INDEX IF EXISTS idx_users_phone_unique`);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
          ON users(phone)
          WHERE phone IS NOT NULL
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_oauth_identities (
          provider TEXT NOT NULL,
          provider_user_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          email TEXT DEFAULT NULL,
          email_verified BOOLEAN NOT NULL DEFAULT false,
          display_name TEXT DEFAULT NULL,
          avatar_url TEXT DEFAULT NULL,
          profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (provider, provider_user_id)
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_oauth_identities_user_provider
          ON user_oauth_identities(user_id, provider)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_oauth_identities_email
          ON user_oauth_identities(LOWER(email))
          WHERE email IS NOT NULL
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_oauth_identities_provider_valid',
        tableName: 'user_oauth_identities',
        expression: `provider IN ('google')`,
        cleanupSql: `DELETE FROM user_oauth_identities
                     WHERE provider NOT IN ('google')`,
      });
    },
  },
  {
    id: '0042_membership_tier_rekey',
    description:
      '迁移会员等级为 Clarity、Insight、Deep 并新增专家 AI 每日次数表',
    async up(client) {
      await client.query(`
        ALTER TABLE membership_config
          DROP CONSTRAINT IF EXISTS chk_membership_config_allowance_positive
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_membership_config_allowance_nonnegative',
        tableName: 'membership_config',
        expression: 'monthly_allowance_units >= 0',
        cleanupSql: `UPDATE membership_config
                     SET monthly_allowance_units = 0
                     WHERE monthly_allowance_units < 0`,
      });
      await client.query(`
        ALTER TABLE membership_allowances
          DROP CONSTRAINT IF EXISTS chk_membership_allowances_units_valid
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_membership_allowances_units_nonnegative',
        tableName: 'membership_allowances',
        expression: 'allowance_units >= 0 AND used_units >= 0',
        cleanupSql: `UPDATE membership_allowances
                     SET allowance_units = GREATEST(allowance_units, 0),
                         used_units = GREATEST(used_units, 0)
                     WHERE allowance_units < 0 OR used_units < 0`,
      });
      await client.query(`
        INSERT INTO membership_config (
          id, enabled, name, monthly_price_coins, display_price_coins,
          monthly_allowance_units, standard_price_per_million_units_coins,
          updated_at
        )
        SELECT
          'fateclaw_insight',
          enabled,
          'FateClaw Insight',
          monthly_price_coins,
          display_price_coins,
          monthly_allowance_units,
          standard_price_per_million_units_coins,
          NOW()
        FROM membership_config
        WHERE id = 'default'
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
      `);
      await client.query(`
        INSERT INTO membership_config (
          id, enabled, name, monthly_price_coins, display_price_coins,
          monthly_allowance_units, standard_price_per_million_units_coins,
          updated_at
        )
        SELECT
          'fateclaw_clarity',
          enabled,
          'FateClaw Clarity',
          10,
          10,
          0,
          standard_price_per_million_units_coins,
          NOW()
        FROM membership_config
        WHERE id = 'fateclaw_insight'
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
      `);
      await client.query(`
        WITH source AS (
          SELECT *
          FROM membership_config
          WHERE id = 'fateclaw_pro'
          UNION ALL
          SELECT *
          FROM membership_config
          WHERE id = 'fateclaw_insight'
          LIMIT 1
        )
        INSERT INTO membership_config (
          id, enabled, name, monthly_price_coins, display_price_coins,
          monthly_allowance_units, standard_price_per_million_units_coins,
          updated_at
        )
        SELECT
          'fateclaw_deep',
          enabled,
          'FateClaw Deep',
          100,
          120,
          monthly_allowance_units,
          standard_price_per_million_units_coins,
          NOW()
        FROM source
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
      `);
      await client.query(`
        UPDATE user_memberships current
        SET current_period_start = LEAST(
              current.current_period_start,
              legacy.current_period_start
            ),
            current_period_end = GREATEST(
              current.current_period_end,
              legacy.current_period_end
            ),
            status = CASE
              WHEN current.status = 'active' OR legacy.status = 'active'
                THEN 'active'
              ELSE current.status
            END,
            updated_at = NOW()
        FROM user_memberships legacy
        WHERE current.user_id = legacy.user_id
          AND current.plan_key = 'fateclaw_insight'
          AND legacy.plan_key = 'fateclaw_plus'
      `);
      await client.query(`
        DELETE FROM user_memberships legacy
        USING user_memberships current
        WHERE legacy.user_id = current.user_id
          AND legacy.plan_key = 'fateclaw_plus'
          AND current.plan_key = 'fateclaw_insight'
      `);
      await client.query(`
        UPDATE user_memberships
        SET plan_key = 'fateclaw_insight',
            updated_at = NOW()
        WHERE plan_key = 'fateclaw_plus'
      `);
      await client.query(`
        UPDATE user_memberships current
        SET current_period_start = LEAST(
              current.current_period_start,
              legacy.current_period_start
            ),
            current_period_end = GREATEST(
              current.current_period_end,
              legacy.current_period_end
            ),
            status = CASE
              WHEN current.status = 'active' OR legacy.status = 'active'
                THEN 'active'
              ELSE current.status
            END,
            updated_at = NOW()
        FROM user_memberships legacy
        WHERE current.user_id = legacy.user_id
          AND current.plan_key = 'fateclaw_deep'
          AND legacy.plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        DELETE FROM user_memberships legacy
        USING user_memberships current
        WHERE legacy.user_id = current.user_id
          AND legacy.plan_key = 'fateclaw_pro'
          AND current.plan_key = 'fateclaw_deep'
      `);
      await client.query(`
        UPDATE user_memberships
        SET plan_key = 'fateclaw_deep',
            updated_at = NOW()
        WHERE plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        UPDATE membership_allowances current
        SET period_end = GREATEST(current.period_end, legacy.period_end),
            allowance_units = GREATEST(
              current.allowance_units,
              legacy.allowance_units
            ),
            used_units = GREATEST(current.used_units, legacy.used_units),
            updated_at = NOW()
        FROM membership_allowances legacy
        WHERE current.user_id = legacy.user_id
          AND current.period_start = legacy.period_start
          AND current.plan_key = 'fateclaw_insight'
          AND legacy.plan_key = 'fateclaw_plus'
      `);
      await client.query(`
        DELETE FROM membership_allowances legacy
        USING membership_allowances current
        WHERE legacy.user_id = current.user_id
          AND legacy.period_start = current.period_start
          AND legacy.plan_key = 'fateclaw_plus'
          AND current.plan_key = 'fateclaw_insight'
      `);
      await client.query(`
        UPDATE membership_allowances
        SET plan_key = 'fateclaw_insight',
            updated_at = NOW()
        WHERE plan_key = 'fateclaw_plus'
      `);
      await client.query(`
        UPDATE membership_allowances current
        SET period_end = GREATEST(current.period_end, legacy.period_end),
            allowance_units = GREATEST(
              current.allowance_units,
              legacy.allowance_units
            ),
            used_units = GREATEST(current.used_units, legacy.used_units),
            updated_at = NOW()
        FROM membership_allowances legacy
        WHERE current.user_id = legacy.user_id
          AND current.period_start = legacy.period_start
          AND current.plan_key = 'fateclaw_deep'
          AND legacy.plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        DELETE FROM membership_allowances legacy
        USING membership_allowances current
        WHERE legacy.user_id = current.user_id
          AND legacy.period_start = current.period_start
          AND legacy.plan_key = 'fateclaw_pro'
          AND current.plan_key = 'fateclaw_deep'
      `);
      await client.query(`
        UPDATE membership_allowances
        SET plan_key = 'fateclaw_deep',
            updated_at = NOW()
        WHERE plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        UPDATE wallet_transactions
        SET metadata = jsonb_set(
              metadata,
              '{planKey}',
              '"fateclaw_insight"'::jsonb,
              false
            )
        WHERE metadata->>'planKey' = 'fateclaw_plus'
      `);
      await client.query(`
        UPDATE wallet_transactions
        SET metadata = jsonb_set(
              metadata,
              '{planKey}',
              '"fateclaw_deep"'::jsonb,
              false
            )
        WHERE metadata->>'planKey' = 'fateclaw_pro'
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ai_chat_professional_daily_usage (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          usage_date TEXT NOT NULL,
          professional_turn_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, usage_date)
        )
      `);
      await client.query(`
        INSERT INTO ai_chat_professional_daily_usage (
          user_id, usage_date, professional_turn_count, created_at, updated_at
        )
        SELECT user_id, usage_date, professional_turn_count, created_at, updated_at
        FROM ai_chat_free_daily_usage
        ON CONFLICT (user_id, usage_date) DO UPDATE SET
          professional_turn_count = GREATEST(
            ai_chat_professional_daily_usage.professional_turn_count,
            EXCLUDED.professional_turn_count
          ),
          updated_at = NOW()
      `);
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_ai_chat_professional_daily_usage_turn_count_nonnegative',
        tableName: 'ai_chat_professional_daily_usage',
        expression: 'professional_turn_count >= 0',
        cleanupSql: `UPDATE ai_chat_professional_daily_usage
                     SET professional_turn_count = GREATEST(
                       professional_turn_count,
                       0
                     )`,
      });
    },
  },
  {
    id: '0043_repair_legacy_pro_to_deep_memberships',
    description: '修复旧 Pro 会员迁移后被低档 Insight 覆盖的问题',
    async up(client) {
      await client.query(`
        INSERT INTO membership_config (
          id, enabled, name, monthly_price_coins, display_price_coins,
          monthly_allowance_units, standard_price_per_million_units_coins,
          updated_at
        )
        SELECT
          'fateclaw_deep',
          enabled,
          'FateClaw Deep',
          100,
          120,
          monthly_allowance_units,
          standard_price_per_million_units_coins,
          NOW()
        FROM membership_config
        WHERE id IN ('fateclaw_pro', 'fateclaw_insight')
        ORDER BY CASE WHEN id = 'fateclaw_pro' THEN 0 ELSE 1 END
        LIMIT 1
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
      `);
      await client.query(`
        UPDATE user_memberships current
        SET current_period_start = LEAST(
              current.current_period_start,
              legacy.current_period_start
            ),
            current_period_end = GREATEST(
              current.current_period_end,
              legacy.current_period_end
            ),
            status = CASE
              WHEN current.status = 'active' OR legacy.status = 'active'
                THEN 'active'
              ELSE current.status
            END,
            updated_at = NOW()
        FROM user_memberships legacy
        WHERE current.user_id = legacy.user_id
          AND current.plan_key = 'fateclaw_deep'
          AND legacy.plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        DELETE FROM user_memberships legacy
        USING user_memberships current
        WHERE legacy.user_id = current.user_id
          AND legacy.plan_key = 'fateclaw_pro'
          AND current.plan_key = 'fateclaw_deep'
      `);
      await client.query(`
        UPDATE user_memberships
        SET plan_key = 'fateclaw_deep',
            updated_at = NOW()
        WHERE plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        UPDATE membership_allowances current
        SET period_end = GREATEST(current.period_end, legacy.period_end),
            allowance_units = GREATEST(
              current.allowance_units,
              legacy.allowance_units
            ),
            used_units = GREATEST(current.used_units, legacy.used_units),
            updated_at = NOW()
        FROM membership_allowances legacy
        WHERE current.user_id = legacy.user_id
          AND current.period_start = legacy.period_start
          AND current.plan_key = 'fateclaw_deep'
          AND legacy.plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        DELETE FROM membership_allowances legacy
        USING membership_allowances current
        WHERE legacy.user_id = current.user_id
          AND legacy.period_start = current.period_start
          AND legacy.plan_key = 'fateclaw_pro'
          AND current.plan_key = 'fateclaw_deep'
      `);
      await client.query(`
        UPDATE membership_allowances
        SET plan_key = 'fateclaw_deep',
            updated_at = NOW()
        WHERE plan_key = 'fateclaw_pro'
      `);
      await client.query(`
        UPDATE wallet_transactions
        SET metadata = jsonb_set(
              metadata,
              '{planKey}',
              '"fateclaw_deep"'::jsonb,
              false
            )
        WHERE metadata->>'planKey' = 'fateclaw_pro'
      `);
      await client.query(`
        WITH pro_sources AS (
          SELECT
            user_id,
            current_period_start AS period_start,
            current_period_end AS period_end,
            NULL::NUMERIC AS allowance_units,
            NULL::NUMERIC AS used_units
          FROM user_memberships
          WHERE plan_key IN ('fateclaw_pro', 'fateclaw_deep')
            AND status = 'active'
            AND current_period_end > NOW()
          UNION ALL
          SELECT
            user_id,
            period_start,
            period_end,
            allowance_units,
            used_units
          FROM membership_allowances
          WHERE plan_key IN ('fateclaw_pro', 'fateclaw_deep')
            AND period_end > NOW()
          UNION ALL
          SELECT
            user_id,
            (metadata->>'periodStart')::TIMESTAMPTZ AS period_start,
            (metadata->>'periodEnd')::TIMESTAMPTZ AS period_end,
            NULLIF(metadata->>'allowanceUnits', '')::NUMERIC AS allowance_units,
            0::NUMERIC AS used_units
          FROM wallet_transactions
          WHERE kind = 'membership_subscription'
            AND metadata->>'planKey' IN ('fateclaw_pro', 'fateclaw_deep')
            AND metadata ? 'periodStart'
            AND metadata ? 'periodEnd'
            AND (metadata->>'periodEnd')::TIMESTAMPTZ > NOW()
        ),
        repair_candidates AS (
          SELECT
            source.user_id,
            MIN(source.period_start) AS period_start,
            MAX(source.period_end) AS period_end,
            MAX(source.allowance_units) AS allowance_units,
            MAX(source.used_units) AS used_units
          FROM pro_sources source
          WHERE source.period_start IS NOT NULL
            AND source.period_end IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM user_memberships insight
              WHERE insight.user_id = source.user_id
                AND insight.plan_key = 'fateclaw_insight'
                AND insight.status = 'active'
                AND insight.current_period_end > NOW()
            )
          GROUP BY source.user_id
        )
        INSERT INTO user_memberships (
          user_id, plan_key, status, current_period_start,
          current_period_end, created_at, updated_at
        )
        SELECT
          user_id,
          'fateclaw_deep',
          'active',
          period_start,
          period_end,
          NOW(),
          NOW()
        FROM repair_candidates
        ON CONFLICT (user_id, plan_key) DO UPDATE SET
          status = 'active',
          current_period_start = LEAST(
            user_memberships.current_period_start,
            EXCLUDED.current_period_start
          ),
          current_period_end = GREATEST(
            user_memberships.current_period_end,
            EXCLUDED.current_period_end
          ),
          updated_at = NOW()
      `);
      await client.query(`
        WITH pro_sources AS (
          SELECT
            user_id,
            period_start,
            period_end,
            allowance_units,
            used_units
          FROM membership_allowances
          WHERE plan_key IN ('fateclaw_pro', 'fateclaw_deep')
            AND period_end > NOW()
          UNION ALL
          SELECT
            user_id,
            (metadata->>'periodStart')::TIMESTAMPTZ AS period_start,
            (metadata->>'periodEnd')::TIMESTAMPTZ AS period_end,
            NULLIF(metadata->>'allowanceUnits', '')::NUMERIC AS allowance_units,
            0::NUMERIC AS used_units
          FROM wallet_transactions
          WHERE kind = 'membership_subscription'
            AND metadata->>'planKey' IN ('fateclaw_pro', 'fateclaw_deep')
            AND metadata ? 'periodStart'
            AND metadata ? 'periodEnd'
            AND (metadata->>'periodEnd')::TIMESTAMPTZ > NOW()
        ),
        insight_usage AS (
          SELECT
            allowance.user_id,
            MAX(allowance.used_units) AS used_units
          FROM membership_allowances allowance
          WHERE allowance.plan_key = 'fateclaw_insight'
            AND allowance.period_end > NOW()
          GROUP BY allowance.user_id
        ),
        repair_candidates AS (
          SELECT
            membership.user_id,
            membership.current_period_start AS period_start,
            membership.current_period_end AS period_end,
            COALESCE(
              MAX(source.allowance_units),
              MAX(config.monthly_allowance_units),
              0
            ) AS allowance_units,
            GREATEST(
              COALESCE(MAX(source.used_units), 0),
              COALESCE(MAX(insight_usage.used_units), 0)
            ) AS used_units
          FROM user_memberships membership
          LEFT JOIN pro_sources source
            ON source.user_id = membership.user_id
          LEFT JOIN insight_usage
            ON insight_usage.user_id = membership.user_id
          LEFT JOIN membership_config config
            ON config.id = 'fateclaw_deep'
          WHERE membership.plan_key = 'fateclaw_deep'
            AND membership.status = 'active'
            AND membership.current_period_end > NOW()
            AND EXISTS (
              SELECT 1
              FROM user_memberships insight
              WHERE insight.user_id = membership.user_id
                AND insight.plan_key = 'fateclaw_insight'
                AND insight.status = 'active'
                AND insight.current_period_end > NOW()
            )
          GROUP BY
            membership.user_id,
            membership.current_period_start,
            membership.current_period_end
        )
        INSERT INTO membership_allowances (
          id, user_id, plan_key, period_start, period_end,
          allowance_units, used_units, created_at, updated_at
        )
        SELECT
          'membership-repair-deep-' ||
            md5(user_id || ':' || period_start::TEXT),
          user_id,
          'fateclaw_deep',
          period_start,
          period_end,
          allowance_units,
          used_units,
          NOW(),
          NOW()
        FROM repair_candidates
        ON CONFLICT (user_id, plan_key, period_start) DO UPDATE SET
          period_end = GREATEST(
            membership_allowances.period_end,
            EXCLUDED.period_end
          ),
          allowance_units = GREATEST(
            membership_allowances.allowance_units,
            EXCLUDED.allowance_units
          ),
          used_units = GREATEST(
            membership_allowances.used_units,
            EXCLUDED.used_units
          ),
          updated_at = NOW()
      `);
    },
  },
];
