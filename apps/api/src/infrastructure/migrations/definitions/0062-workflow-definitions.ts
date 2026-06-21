import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0062。
 *
 * 卦师自定义工作流：多步线性流程的"定义"表(模板),归属卦师 user_id。
 * steps 为有序 JSONB(WorkflowStepDto[]);运行不另建状态表,run = chat session(详见设计稿
 * docs/spark/2026-06-21-guashi-custom-workflow-design.md)。软删复用 deleted_at。
 */
export const workflowDefinitionsMigrations: readonly DatabaseMigration[] = [
  {
    id: '0062_workflow_definitions',
    description: '增加卦师自定义工作流定义表(多步线性流程)',
    async up(client) {
      // 工作流定义归属卦师(user_id),用户删号级联清理;steps 存有序步骤数组。
      await client.query(`
        CREATE TABLE IF NOT EXISTS workflow_definitions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          steps JSONB NOT NULL DEFAULT '[]'::jsonb,
          enabled BOOLEAN NOT NULL DEFAULT true,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        )
      `);
      // 列表按 sort_order 升序、创建时间倒序拉取,部分索引只覆盖未删除记录。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_definitions_user
          ON workflow_definitions(user_id, sort_order ASC, created_at DESC)
          WHERE deleted_at IS NULL
      `);
    },
  },
];
