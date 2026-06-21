import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0065。
 *
 * 卦师工作流"两套体系"收尾:给 chat_sessions 加两列区分"对话"与"workflow 运行"。
 * - origin:会话来源('chat' 直接对话 / 'workflow_run' 工作流运行)。workflow 运行会话不进对话历史侧栏。
 * - workflow_definition_id:workflow 运行会话关联的工作流定义 id,供运行历史按工作流聚合查询。
 *
 * @remarks 用 IF NOT EXISTS 守卫保证幂等;origin 默认 'chat',旧会话与直接对话不受影响。
 */
export const chatSessionWorkflowOriginMigrations: readonly DatabaseMigration[] = [
  {
    id: '0065_chat_session_workflow_origin',
    description: '会话加 origin + workflow_definition_id(区分对话与 workflow 运行)',
    async up(client) {
      await client.query(`
        ALTER TABLE chat_sessions
          ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'chat'
      `);
      await client.query(`
        ALTER TABLE chat_sessions
          ADD COLUMN IF NOT EXISTS workflow_definition_id text
      `);
      // 运行历史按 (user_id, workflow_definition_id) 聚合查询,建部分索引加速。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_workflow_def
          ON chat_sessions (user_id, workflow_definition_id)
          WHERE workflow_definition_id IS NOT NULL
      `);
    },
  },
];
