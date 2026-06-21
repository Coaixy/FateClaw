import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0067。
 *
 * 卦师工作流架构升级 P1:把"运行态"提为独立领域实体。
 * - workflow_runs:一次运行的聚合根(状态/输入/关联客户/归属);产出仍落 chat_session(chat_session_id)。
 * - workflow_run_nodes:每个节点的编排状态 + 复合外键指针 (output_message_id, output_account_id) →
 *   messages(id, account_id)。产出正文不复制进 run_node,单一真相留 messages(卦师润色即改 message)。
 *
 * @remarks
 * - 全程 IF NOT EXISTS、forward-only、幂等。
 * - messages 主键是复合 (id, account_id),故 run_node 的产出外键必须是复合外键(单列 FK 物理不可行)。
 * - workflow_definition_id 不设外键:运行是历史记录,需在定义被(将来)硬删后仍存活。
 * - P1 本刀只建表 + 仓储 + 编排逻辑,不接前端、不接真实执行(那在 P2/P3),纯 additive 零线上影响。
 */
export const workflowRunsMigrations: readonly DatabaseMigration[] = [
  {
    id: '0067_workflow_runs',
    description: '增加 workflow_runs / workflow_run_nodes(独立运行态领域实体)',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          workflow_definition_id TEXT NOT NULL,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          client_id TEXT REFERENCES client_profiles(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running','paused','done','error','canceled')),
          input JSONB NOT NULL DEFAULT '{}'::jsonb,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // 运行历史按 (user_id, workflow_definition_id, created_at DESC) 聚合倒序。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_def
          ON workflow_runs(user_id, workflow_definition_id, created_at DESC)
      `);
      // 活跃运行扫描(恢复/超时接管):只覆盖 running/paused。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_active
          ON workflow_runs(status)
          WHERE status IN ('running','paused')
      `);
      // 按会话反查运行(outbox 落回复后定位 run)。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_session
          ON workflow_runs(chat_session_id)
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS workflow_run_nodes (
          run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL CHECK (node_type IN ('paipan','ai')),
          title TEXT NOT NULL DEFAULT '',
          pause_after BOOLEAN NOT NULL DEFAULT false,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','running','awaiting_paipan','done','error','skipped','manual')),
          output_message_id TEXT,
          output_account_id TEXT,
          error TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (run_id, node_id),
          FOREIGN KEY (output_message_id, output_account_id)
            REFERENCES messages(id, account_id) ON DELETE SET NULL
        )
      `);
      // 按产出消息反查节点(P3 进度投影 / 校验)。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_run_nodes_message
          ON workflow_run_nodes(output_message_id, output_account_id)
          WHERE output_message_id IS NOT NULL
      `);
    },
  },
];
