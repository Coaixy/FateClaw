import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  createPublicFinancialLedgerEntry,
  deletePublicFinancialLedgerEntry,
  listPublicFinancialLedgerEntries,
  updatePublicFinancialLedgerEntry,
} from '../../../src/infrastructure/repositories/public-financial-ledger-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

type MockQueryResult = unknown[] | { rows?: unknown[]; rowCount?: number };

function normalizeResult(result: MockQueryResult | undefined) {
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return {
    rows: result?.rows ?? [],
    rowCount: result?.rowCount ?? result?.rows?.length ?? 0,
  };
}

function createMockPool(results: MockQueryResult[] = []) {
  const calls: QueryCall[] = [];
  let resultIdx = 0;
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return normalizeResult(results[resultIdx++]);
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls };
}

describe('public financial ledger repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists entries by occurred date and normalizes numeric amounts', async () => {
    const { calls } = createMockPool([
      [
        {
          id: 'entry-1',
          entry_type: 'expense',
          occurred_at: '2026-05-31',
          content: '服务器成本',
          amount_yuan: '500.00',
          created_at: '2026-05-31T00:00:00.000Z',
          updated_at: '2026-05-31T00:00:00.000Z',
        },
      ],
    ]);

    await expect(listPublicFinancialLedgerEntries()).resolves.toEqual([
      expect.objectContaining({
        id: 'entry-1',
        amount_yuan: 500,
      }),
    ]);

    expect(calls[0]?.sql).toContain(
      'ORDER BY occurred_at DESC, created_at DESC',
    );
  });

  it('creates entries with generated ids', async () => {
    const { calls } = createMockPool([
      [
        {
          id: 'entry-1',
          entry_type: 'income',
          occurred_at: '2026-05-31',
          content: '赞助收入',
          amount_yuan: '20.00',
          created_at: '2026-05-31T00:00:00.000Z',
          updated_at: '2026-05-31T00:00:00.000Z',
        },
      ],
    ]);

    await createPublicFinancialLedgerEntry({
      entryType: 'income',
      occurredAt: '2026-05-31',
      content: '赞助收入',
      amountYuan: 20,
    });

    expect(calls[0]?.sql).toContain(
      'INSERT INTO public_financial_ledger_entries',
    );
    expect(calls[0]?.params).toEqual([
      expect.stringMatching(/^public-ledger-/),
      'income',
      '2026-05-31',
      '赞助收入',
      20,
    ]);
  });

  it('returns null when updating a missing entry', async () => {
    createMockPool([[]]);

    await expect(
      updatePublicFinancialLedgerEntry('missing-entry', {
        entryType: 'expense',
        occurredAt: '2026-05-31',
        content: '服务器成本',
        amountYuan: 500,
      }),
    ).resolves.toBeNull();
  });

  it('reports whether delete removed a row', async () => {
    createMockPool([{ rowCount: 1 }, { rowCount: 0 }]);

    await expect(deletePublicFinancialLedgerEntry('entry-1')).resolves.toBe(
      true,
    );
    await expect(deletePublicFinancialLedgerEntry('entry-2')).resolves.toBe(
      false,
    );
  });
});
