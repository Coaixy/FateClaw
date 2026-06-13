import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCalculateTextSkillBundleChecksum,
  mockGetDbPool,
  mockReadTextSkillBundleFiles,
  mockWriteTextSkillBundleFiles,
} = vi.hoisted(() => ({
  mockCalculateTextSkillBundleChecksum: vi.fn(),
  mockGetDbPool: vi.fn(),
  mockReadTextSkillBundleFiles: vi.fn(),
  mockWriteTextSkillBundleFiles: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../../src/modules/skills/text-skill-bundle-store.js', () => ({
  calculateTextSkillBundleChecksum: mockCalculateTextSkillBundleChecksum,
  readTextSkillBundleFiles: mockReadTextSkillBundleFiles,
  writeTextSkillBundleFiles: mockWriteTextSkillBundleFiles,
}));

import { updateSimpleWorkflowPreset } from '../../../src/infrastructure/repositories/simple-workflow-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function simpleWorkflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'simple-natal-default',
    kind: 'natal',
    name: '默认命理分析',
    enabled: true,
    is_default: false,
    entry_title: '命理分析',
    entry_description: 'desc',
    paipan_skill: 'bazi-paipan',
    paipan_input_defaults: { include: ['bazi'] },
    model_policy: { mode: 'user-current', thinkingLevel: 'medium' },
    skill_bundle_ids: ['bundle-old'],
    skill_ids: ['skill-old'],
    skill_snapshot_ids: ['snapshot-old'],
    prompt_template: '模板',
    sort_order: 20,
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

function createSimpleWorkflowMockPool(clientRows: unknown[][]) {
  const poolCalls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  let poolQueryIndex = 0;
  let clientQueryIndex = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE simple_workflow_presets')) {
        const rows = [
          simpleWorkflowRow({
            name: params?.[1],
            skill_bundle_ids: params?.[8],
            skill_ids: params?.[9],
            skill_snapshot_ids: params?.[10],
          }),
        ];
        return { rows, rowCount: rows.length };
      }
      const rows =
        clientRows[Math.min(clientQueryIndex, clientRows.length - 1)] ?? [];
      clientQueryIndex += 1;
      return { rows, rowCount: rows.length };
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      poolCalls.push({ sql, params });
      const rows = poolQueryIndex === 0 ? [simpleWorkflowRow()] : [];
      poolQueryIndex += 1;
      return { rows, rowCount: rows.length };
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { client, clientCalls, poolCalls };
}

describe('simple workflow repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadTextSkillBundleFiles.mockReturnValue([
      { path: 'SKILL.md', content: '# 固定知识' },
      { path: 'docs/knowledge.md', content: '保存时的内容' },
    ]);
    mockCalculateTextSkillBundleChecksum.mockReturnValue('source-checksum');
    mockWriteTextSkillBundleFiles.mockReturnValue({
      bundleUri: 'text-skill://workflow-snapshot',
      checksum: 'snapshot-checksum',
    });
  });

  it('snapshots selected skills when updating workflow binding', async () => {
    const { client, clientCalls } = createSimpleWorkflowMockPool([
      [
        {
          skill_id: 'skill-bazi',
          user_id: 'creator-1',
          skill_name: '八字知识',
          dir_name: 'bazi-knowledge',
          description: 'desc',
          bundle_uri: 'text-skill://source-bazi',
        },
      ],
      [],
    ]);

    await expect(
      updateSimpleWorkflowPreset({
        id: 'simple-natal-default',
        skillIds: ['skill-bazi'],
      }),
    ).resolves.toMatchObject({
      id: 'simple-natal-default',
      skill_bundle_ids: [],
      skill_ids: ['skill-bazi'],
      skill_snapshot_ids: [
        expect.stringMatching(/^workflow-snapshot-[a-f0-9]{16}$/),
      ],
    });

    expect(mockReadTextSkillBundleFiles).toHaveBeenCalledWith(
      'text-skill://source-bazi',
    );
    expect(mockWriteTextSkillBundleFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'creator-1',
        fallbackSkillName: '八字知识',
        dirName: expect.stringMatching(/^workflow-bazi-knowledge-[a-f0-9]{10}$/),
        files: [
          { path: 'SKILL.md', content: '# 固定知识' },
          { path: 'docs/knowledge.md', content: '保存时的内容' },
        ],
      }),
    );
    expect(
      clientCalls.some((call) =>
        call.sql.includes('INSERT INTO user_custom_skills'),
      ),
    ).toBe(true);
    expect(
      clientCalls.some((call) =>
        call.sql.includes('skill_snapshot_ids = $11::text[]'),
      ),
    ).toBe(true);
    expect(
      clientCalls.find((call) =>
        call.sql.includes('UPDATE simple_workflow_presets'),
      )?.params?.[8],
    ).toEqual([]);
    expect(clientCalls.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('keeps existing snapshots when updating non-skill workflow fields', async () => {
    const { client, clientCalls } = createSimpleWorkflowMockPool([]);

    await expect(
      updateSimpleWorkflowPreset({
        id: 'simple-natal-default',
        name: '新名称',
      }),
    ).resolves.toMatchObject({
      name: '新名称',
      skill_bundle_ids: ['bundle-old'],
      skill_ids: ['skill-old'],
      skill_snapshot_ids: ['snapshot-old'],
    });

    expect(mockReadTextSkillBundleFiles).not.toHaveBeenCalled();
    expect(mockWriteTextSkillBundleFiles).not.toHaveBeenCalled();
    expect(
      clientCalls.some((call) =>
        call.sql.includes('INSERT INTO user_custom_skills'),
      ),
    ).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
