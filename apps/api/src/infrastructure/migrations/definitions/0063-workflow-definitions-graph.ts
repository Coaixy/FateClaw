import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0063。
 *
 * 卦师工作流从"多步线性"改写为"画布 DAG(并行分叉 + 汇总)":
 * 把 workflow_definitions.steps(WorkflowStepDto[])改名为 graph(WorkflowGraphDto = { nodes, edges })。
 * 功能未上线、表内无业务数据,故直接改名 + 改默认值。设计稿
 * docs/spark/2026-06-21-guashi-workflow-dag-design.md。
 *
 * @remarks 用 IF EXISTS / NOT EXISTS 守卫保证幂等(0062 已建 steps 列时才改名;已是 graph 则跳过)。
 */
export const workflowDefinitionsGraphMigrations: readonly DatabaseMigration[] = [
  {
    id: '0063_workflow_definitions',
    description: '卦师工作流 steps → graph(画布 DAG:并行分叉+汇总)',
    async up(client) {
      // 仅当旧 steps 列在、新 graph 列不在时改名,保证可重复执行。
      await client.query(`DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'workflow_definitions' AND column_name = 'steps'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'workflow_definitions' AND column_name = 'graph'
          ) THEN
            ALTER TABLE workflow_definitions RENAME COLUMN steps TO graph;
          END IF;
        END $$;`);
      // 默认值从线性的 '[]' 改为图形状,避免新行落空数组。
      await client.query(`
        ALTER TABLE workflow_definitions
          ALTER COLUMN graph SET DEFAULT '{"nodes":[],"edges":[]}'::jsonb
      `);
    },
  },
];
