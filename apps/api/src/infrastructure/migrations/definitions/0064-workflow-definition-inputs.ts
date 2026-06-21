import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0064。
 *
 * 卦师工作流加"运行前输入项"配置(WorkflowRunInputDto[]):
 * workflow_definitions 加 inputs JSONB 列(默认空数组),让卦师能定义运行前要填哪几项,
 * 运行页据此渲染多输入框、AI 节点 prompt 用 {{input.<key>}} 引用。
 *
 * @remarks 用 IF NOT EXISTS 守卫保证幂等;默认空数组,旧行运行页回退默认 question 输入。
 */
export const workflowDefinitionInputsMigrations: readonly DatabaseMigration[] = [
  {
    id: '0064_workflow_definition_inputs',
    description: '卦师工作流加运行前输入项配置(inputs JSONB)',
    async up(client) {
      await client.query(`
        ALTER TABLE workflow_definitions
          ADD COLUMN IF NOT EXISTS inputs jsonb NOT NULL DEFAULT '[]'::jsonb
      `);
    },
  },
];
