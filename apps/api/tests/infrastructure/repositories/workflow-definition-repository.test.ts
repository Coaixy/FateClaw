import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool, mockReadFiles, mockWriteFiles, mockChecksum } =
  vi.hoisted(() => ({
    mockGetDbPool: vi.fn(),
    mockReadFiles: vi.fn(),
    mockWriteFiles: vi.fn(),
    mockChecksum: vi.fn(),
  }));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../../src/modules/skills/text-skill-bundle-store.js', () => ({
  calculateTextSkillBundleChecksum: mockChecksum,
  readTextSkillBundleFiles: mockReadFiles,
  writeTextSkillBundleFiles: mockWriteFiles,
}));

import {
  createWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitionsByUserId,
  softDeleteWorkflowDefinition,
  updateWorkflowDefinition,
} from '../../../src/infrastructure/repositories/workflow-definition-repository.js';
import type { WorkflowGraphDto } from '@fateclaw/contracts/workflow';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

interface QueryResponse {
  rows: unknown[];
  rowCount?: number;
}

/** 一个只含单排盘节点的极简图。 */
function singlePaipanGraph(): WorkflowGraphDto {
  return {
    nodes: [
      {
        id: 'n1',
        type: 'paipan',
        title: '排盘',
        pauseAfter: false,
        position: { x: 0, y: 0 },
        skill: 'bazi-paipan',
        inputDefaults: {},
      },
    ],
    edges: [],
  };
}

/** 一行工作流定义(graph 含一个排盘节点)。 */
function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workflow-1',
    user_id: 'user-1',
    name: '深度事业分析',
    description: '',
    graph: singlePaipanGraph(),
    inputs: [],
    enabled: true,
    sort_order: 0,
    created_at: '2026-06-21T00:00:00.000Z',
    updated_at: '2026-06-21T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * 单一有序响应队列的 mock pool;pool.query 与事务 client.query 共享同一队列与记录器,
 * 所以测试按代码实际发起 query 的顺序排响应即可。
 */
function mockPool(responses: QueryResponse[]) {
  const calls: QueryCall[] = [];
  let index = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    const response = responses[index] ?? { rows: [] };
    index += 1;
    return {
      rows: response.rows,
      rowCount: response.rowCount ?? response.rows.length,
    };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  mockGetDbPool.mockReturnValue({ query, connect });
  return { calls, connect };
}

/** 按 sql 子串找到对应 query 调用。 */
function findCall(calls: QueryCall[], fragment: string): QueryCall | undefined {
  return calls.find((call) => call.sql.includes(fragment));
}

describe('workflow-definition-repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFiles.mockReturnValue([{ path: 'SKILL.md', content: '# x' }]);
    mockChecksum.mockReturnValue('sum-1');
    mockWriteFiles.mockReturnValue({ bundleUri: 'snap-uri', checksum: 'sum-1' });
  });

  it('列表查询按 user_id 隔离并过滤软删除', async () => {
    const { calls } = mockPool([{ rows: [workflowRow()] }]);
    const result = await listWorkflowDefinitionsByUserId('user-1');

    expect(result).toHaveLength(1);
    expect(result[0]?.graph.nodes).toHaveLength(1);
    expect(calls[0]?.sql).toContain('user_id = $1');
    expect(calls[0]?.sql).toContain('deleted_at IS NULL');
    expect(calls[0]?.params).toEqual(['user-1']);
  });

  it('读取单个会同时带上 id 与 user_id 双条件', async () => {
    const { calls } = mockPool([{ rows: [workflowRow()] }]);
    const record = await getWorkflowDefinition('workflow-1', 'user-1');

    expect(record?.id).toBe('workflow-1');
    expect(calls[0]?.sql).toContain('id = $1 AND user_id = $2');
    expect(calls[0]?.params).toEqual(['workflow-1', 'user-1']);
  });

  it('读取不到时返回 undefined', async () => {
    mockPool([{ rows: [] }]);
    const record = await getWorkflowDefinition('missing', 'user-1');
    expect(record).toBeUndefined();
  });

  it('归一脏 graph:非对象落为空图', async () => {
    mockPool([{ rows: [workflowRow({ graph: 'not-an-object' })] }]);
    const record = await getWorkflowDefinition('workflow-1', 'user-1');
    expect(record?.graph).toEqual({ nodes: [], edges: [] });
  });

  it('归一脏 inputs:非数组落为空、缺 key/label 的项被剔除、type 兜底为 text', async () => {
    mockPool([
      {
        rows: [
          workflowRow({
            inputs: [
              { key: 'question', label: '问题', type: 'textarea', required: true },
              { key: 'extra', label: '补充' }, // 缺 type/required → type 兜底 text、required 兜底 false
              { label: '无键' }, // 缺 key → 剔除
              'garbage', // 非对象 → 剔除
            ],
          }),
        ],
      },
    ]);
    const record = await getWorkflowDefinition('workflow-1', 'user-1');
    expect(record?.inputs).toEqual([
      { key: 'question', label: '问题', type: 'textarea', required: true },
      { key: 'extra', label: '补充', type: 'text', required: false },
    ]);
  });

  it('创建无绑定 skill 的工作流:走事务,graph 序列化为 JSONB 入参', async () => {
    // 事务内 query 顺序:BEGIN → 清孤儿快照 UPDATE → INSERT RETURNING → COMMIT
    const { calls, connect } = mockPool([
      { rows: [] },
      { rows: [] },
      { rows: [workflowRow()] },
      { rows: [] },
    ]);
    await createWorkflowDefinition({
      userId: 'user-1',
      name: '事业分析',
      description: 'd',
      graph: singlePaipanGraph(),
      inputs: [
        { key: 'question', label: '本次要问的事', type: 'textarea', required: false },
      ],
      enabled: true,
      sortOrder: 0,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    const insert = findCall(calls, 'INSERT INTO workflow_definitions');
    expect(insert?.params?.[4]).toBe(JSON.stringify(singlePaipanGraph()));
    // inputs 作为第 6 个参数($6)写入
    expect(insert?.params?.[5]).toBe(
      JSON.stringify([
        { key: 'question', label: '本次要问的事', type: 'textarea', required: false },
      ]),
    );
    // 没有绑定 skill 时不应读写 skill bundle
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it('创建带绑定 skill 的 AI 节点:生成快照并把快照 id 回填到该节点', async () => {
    const aiNode = {
      id: 'n2',
      type: 'ai' as const,
      title: 'AI 初断',
      pauseAfter: true,
      position: { x: 200, y: 0 },
      promptTemplate: '{{node.n1.output}}',
      skillIds: ['skill-a'],
      skillSnapshotIds: [],
      modelPolicy: { mode: 'user-current' as const },
    };
    const aiGraph: WorkflowGraphDto = {
      nodes: [aiNode],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    // 事务内:BEGIN → listSnapshotSources SELECT → upsert 快照 INSERT → 清孤儿 UPDATE → INSERT 定义 → COMMIT
    const { calls } = mockPool([
      { rows: [] }, // BEGIN
      {
        rows: [
          {
            skill_id: 'skill-a',
            user_id: 'user-1',
            skill_name: '格局法',
            dir_name: 'gejufa',
            description: '',
            bundle_uri: 'uri-a',
          },
        ],
      }, // listSnapshotSources
      { rows: [] }, // upsert 快照
      { rows: [] }, // 清孤儿
      { rows: [workflowRow({ graph: aiGraph })] }, // INSERT 定义 RETURNING
      { rows: [] }, // COMMIT
    ]);

    await createWorkflowDefinition({
      userId: 'user-1',
      name: '事业分析',
      description: '',
      graph: aiGraph,
      inputs: [],
      enabled: true,
      sortOrder: 0,
    });

    expect(mockWriteFiles).toHaveBeenCalledTimes(1);
    const snapshotInsert = findCall(calls, 'INSERT INTO user_custom_skills');
    const snapshotId = snapshotInsert?.params?.[0] as string;
    expect(snapshotId).toMatch(/^workflow-def-snapshot-/);

    // 定义 INSERT 里该 AI 节点的 skillSnapshotIds 应被回填为刚生成的快照 id
    const defInsert = findCall(calls, 'INSERT INTO workflow_definitions');
    const storedGraph = JSON.parse(defInsert?.params?.[4] as string);
    expect(storedGraph.nodes[0].skillSnapshotIds).toEqual([snapshotId]);
  });

  it('更新会先按归属读取,缺失时直接返回 undefined 不开事务', async () => {
    const { calls, connect } = mockPool([{ rows: [] }]);
    const result = await updateWorkflowDefinition('workflow-1', 'user-1', {
      name: '改名',
    });
    expect(result).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('SELECT');
  });

  it('更新只覆盖传入字段,其余沿用当前值', async () => {
    // 顺序:SELECT 当前 → BEGIN → 清孤儿 → UPDATE RETURNING → COMMIT
    const { calls } = mockPool([
      { rows: [workflowRow({ name: '老名字', sort_order: 3 })] },
      { rows: [] },
      { rows: [] },
      { rows: [workflowRow({ name: '新名字', sort_order: 3 })] },
      { rows: [] },
    ]);
    const result = await updateWorkflowDefinition('workflow-1', 'user-1', {
      name: '新名字',
    });

    expect(result?.name).toBe('新名字');
    const update = findCall(calls, 'UPDATE workflow_definitions');
    // params: [id, userId, name, description, graphJson, inputsJson, enabled, sortOrder]
    expect(update?.params?.[2]).toBe('新名字');
    expect(update?.params?.[7]).toBe(3); // sort_order 沿用当前值
  });

  it('软删除命中记录返回 true,未命中返回 false', async () => {
    mockPool([{ rows: [], rowCount: 1 }]);
    expect(await softDeleteWorkflowDefinition('workflow-1', 'user-1')).toBe(
      true,
    );

    mockPool([{ rows: [], rowCount: 0 }]);
    expect(await softDeleteWorkflowDefinition('missing', 'user-1')).toBe(false);
  });
});
