import type pg from 'pg';
import {
  appendLegacyTriggerHintToSkillBundle,
  writeTextSkillBundle,
} from '../../modules/skills/text-skill-bundle-store.js';

async function tableExists(
  client: pg.PoolClient,
  tableName: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return rows[0]?.exists ?? false;
}

async function columnExists(
  client: pg.PoolClient,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [tableName, columnName],
  );
  return rows[0]?.exists ?? false;
}

/**
 * 将历史内联用户 Skill 正文迁移为文件系统 Text Skill Bundle。
 *
 * @param client PostgreSQL 连接池客户端。
 * @returns 所有可迁移的历史正文写入 Bundle 并更新元数据后返回。
 * @remarks 会兼容旧表或旧列不存在的部署状态；无法读取到旧正文时直接跳过。
 */
export async function migrateLegacyUserCustomSkillContentToBundles(
  client: pg.PoolClient,
): Promise<void> {
  const hasInlineContent = await columnExists(
    client,
    'user_custom_skills',
    'content',
  );
  const hasContentTable = await tableExists(
    client,
    'user_custom_skill_contents',
  );
  const hasTriggerHint = await columnExists(
    client,
    'user_custom_skills',
    'trigger_hint',
  );
  if (!hasInlineContent && !hasContentTable && !hasTriggerHint) return;

  const contentExpr =
    hasInlineContent && hasContentTable
      ? `COALESCE(sc.content, s.content, '')`
      : hasContentTable
        ? `COALESCE(sc.content, '')`
        : hasInlineContent
          ? `COALESCE(s.content, '')`
          : `''`;
  const triggerHintExpr = hasTriggerHint
    ? `COALESCE(s.trigger_hint, '')`
    : `''`;
  const contentJoin = hasContentTable
    ? `LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id`
    : '';
  const { rows } = await client.query<{
    id: string;
    user_id: string;
    skill_name: string;
    dir_name: string;
    description: string;
    trigger_hint: string;
    content: string;
  }>(
    `SELECT s.id, s.user_id, s.skill_name, s.dir_name, s.description,
            ${triggerHintExpr} AS trigger_hint, ${contentExpr} AS content
     FROM user_custom_skills s
     ${contentJoin}
     WHERE s.deleted_at IS NULL
       AND (
         s.bundle_uri IS NULL
         OR s.bundle_uri = ''
         OR s.install_status <> 'installed'
       )`,
  );

  for (const row of rows) {
    const bundle = writeTextSkillBundle({
      skillId: row.id,
      ownerId: row.user_id,
      dirName: row.dir_name,
      skillName: row.skill_name,
      description: row.description,
      triggerHint: row.trigger_hint,
      content: row.content ?? '',
    });
    await client.query(
      `UPDATE user_custom_skills
       SET bundle_uri = $1,
           checksum = $2,
           install_status = 'installed',
           audit_metadata = COALESCE(audit_metadata, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE id = $4`,
      [
        bundle.bundleUri,
        bundle.checksum,
        JSON.stringify({
          legacy_content_migrated_at: new Date().toISOString(),
          legacy_content_source: hasContentTable
            ? 'user_custom_skill_contents'
            : 'user_custom_skills.content',
        }),
        row.id,
      ],
    );
  }
}

/**
 * 将历史路由提示追加到已生成的 Text Skill Bundle 中。
 *
 * @param client PostgreSQL 连接池客户端。
 * @returns 所有可追加的历史路由提示写入 Bundle 并更新校验和后返回。
 * @remarks 只处理仍存在 `trigger_hint` 列且已有 `bundle_uri` 的记录。
 */
export async function migrateLegacyUserCustomSkillRoutingToBundles(
  client: pg.PoolClient,
): Promise<void> {
  const hasTriggerHint = await columnExists(
    client,
    'user_custom_skills',
    'trigger_hint',
  );
  if (!hasTriggerHint) return;

  const { rows } = await client.query<{
    id: string;
    bundle_uri: string;
    trigger_hint: string;
  }>(
    `SELECT id, bundle_uri, trigger_hint
     FROM user_custom_skills
     WHERE deleted_at IS NULL
       AND COALESCE(trigger_hint, '') <> ''
       AND COALESCE(bundle_uri, '') <> ''`,
  );

  for (const row of rows) {
    const checksum = appendLegacyTriggerHintToSkillBundle(
      row.bundle_uri,
      row.trigger_hint,
    );
    if (!checksum) continue;
    await client.query(
      `UPDATE user_custom_skills
       SET checksum = $1,
           audit_metadata = COALESCE(audit_metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [
        checksum,
        JSON.stringify({
          legacy_trigger_hint_migrated_at: new Date().toISOString(),
        }),
        row.id,
      ],
    );
  }
}

/**
 * 删除旧版用户 Skill 路由字段和相关约束。
 *
 * @param client PostgreSQL 连接池客户端。
 * @returns 旧字段与旧约束幂等删除完成后返回。
 * @remarks 该 helper 只面向迁移流程，不会删除当前 Text Skill Bundle 文件。
 */
export async function dropLegacyUserCustomSkillRoutingColumns(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_user_custom_skills_usage_mode_valid'
      ) THEN
        ALTER TABLE user_custom_skills
          DROP CONSTRAINT chk_user_custom_skills_usage_mode_valid;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_user_custom_skills_priority_nonnegative'
      ) THEN
        ALTER TABLE user_custom_skills
          DROP CONSTRAINT chk_user_custom_skills_priority_nonnegative;
      END IF;
    END $$;
  `);
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS trigger_hint`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS category`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS category_normalized`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS match_keywords`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS match_patterns`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS example_queries`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS priority`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS usage_mode`,
  );
}

/**
 * 幂等创建外键约束，并可在创建前执行清理 SQL。
 *
 * @param client PostgreSQL 连接池客户端。
 * @param input 外键名称、表列、引用目标、删除行为和可选清理 SQL。
 * @returns 约束已存在或创建完成后返回。
 * @remarks `input` 目前只由内置迁移常量传入，不接受用户输入。
 */
export async function ensureForeignKey(
  client: pg.PoolClient,
  input: {
    constraintName: string;
    tableName: string;
    columnName: string;
    referencedTable: string;
    referencedColumn?: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    cleanupSql?: string;
  },
): Promise<void> {
  const referencedColumn = input.referencedColumn ?? 'id';
  const onDeleteClause = input.onDelete ? ` ON DELETE ${input.onDelete}` : '';
  const cleanupSql = input.cleanupSql ? `${input.cleanupSql};` : '';
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${input.constraintName}'
      ) THEN
        ${cleanupSql}
        ALTER TABLE ${input.tableName}
          ADD CONSTRAINT ${input.constraintName}
          FOREIGN KEY (${input.columnName})
          REFERENCES ${input.referencedTable}(${referencedColumn})${onDeleteClause};
      END IF;
    END $$;
  `);
}

/**
 * 幂等创建 CHECK 约束，并可在创建前执行清理 SQL。
 *
 * @param client PostgreSQL 连接池客户端。
 * @param input 约束名称、目标表、检查表达式和可选清理 SQL。
 * @returns 约束已存在或创建完成后返回。
 * @remarks `input` 目前只由内置迁移常量传入，不接受用户输入。
 */
export async function ensureCheckConstraint(
  client: pg.PoolClient,
  input: {
    constraintName: string;
    tableName: string;
    expression: string;
    cleanupSql?: string;
  },
): Promise<void> {
  const cleanupSql = input.cleanupSql ? `${input.cleanupSql};` : '';
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${input.constraintName}'
      ) THEN
        ${cleanupSql}
        ALTER TABLE ${input.tableName}
          ADD CONSTRAINT ${input.constraintName}
          CHECK (${input.expression});
      END IF;
    END $$;
  `);
}
