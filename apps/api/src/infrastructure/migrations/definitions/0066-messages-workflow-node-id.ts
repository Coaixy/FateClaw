import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0066。
 *
 * 卦师工作流架构升级 P0 地基:给 messages 加 workflow_node_id 列,把"节点↔产出"关联从消息 id
 * 字符串约定(wf-<nodeId>-<ts>-<rand>_reply)升级为结构化列,供后端按列查、并为 P1 的
 * workflow_run_nodes 外键关联铺路。
 *
 * @remarks
 * - 纯 additive:只加列 + 回填 + 部分索引,不删旧 id 约定(id 约定的移除留到 P4)。
 * - 回填分两路:
 *   1) 排盘盘面 / 手填回复本就带 metadata.workflow_node_id(服务层自落库时写入),直接取,零歧义。
 *   2) AI 回复由 outbox handler 异步落库、metadata 无 node id,按 id 约定 `wf-<nodeId>-…_reply`
 *      提取首段;限定 workflow 运行会话内、只认单段 `_reply`(与既有 collectNodeOutputs 读口径一致,
 *      多段 `_reply_N` 维持既有"不收集"行为)。旧 nodeId 受路由 [A-Za-z0-9_] 约束,故首段切分安全。
 * - 全程 IF NOT EXISTS / WHERE ... IS NULL 守卫,幂等可重跑。
 */
export const messagesWorkflowNodeIdMigrations: readonly DatabaseMigration[] = [
  {
    id: '0066_messages_workflow_node_id',
    description: 'messages 加 workflow_node_id 列 + 回填(节点产出关联结构化)',
    async up(client) {
      await client.query(`
        ALTER TABLE messages
          ADD COLUMN IF NOT EXISTS workflow_node_id text
      `);

      // 回填(1):盘面 / 手填回复已带 metadata.workflow_node_id,直接取。
      await client.query(`
        UPDATE messages
          SET workflow_node_id = metadata->>'workflow_node_id'
          WHERE workflow_node_id IS NULL
            AND metadata->>'workflow_node_id' IS NOT NULL
            AND metadata->>'workflow_node_id' <> ''
      `);

      // 回填(2):AI 回复按 id 约定提取 nodeId;限定 workflow 运行会话、单段 `_reply`。
      await client.query(`
        UPDATE messages m
          SET workflow_node_id = substring(m.id from '^wf-([A-Za-z0-9_]+)-')
          WHERE m.workflow_node_id IS NULL
            AND m.id ~ '^wf-[A-Za-z0-9_]+-.+_reply$'
            AND m.id NOT LIKE 'wf-board-%'
            AND m.id NOT LIKE 'wf-run-%'
            AND EXISTS (
              SELECT 1 FROM chat_sessions s
              WHERE s.id = m.session_id
                AND s.account_id = m.account_id
                AND s.origin = 'workflow_run'
            )
      `);

      // 部分索引:按 (session_id, workflow_node_id) 取某节点最新产出。
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_session_workflow_node
          ON messages (session_id, workflow_node_id)
          WHERE workflow_node_id IS NOT NULL
      `);
    },
  },
];
