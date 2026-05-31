import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { getDbPool } from '../db-pool.js';

const pool = {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<Row>> {
    return getDbPool().query(sql, params);
  },
};

const PUBLIC_LEDGER_COLUMNS = `
  id,
  entry_type,
  occurred_at::text AS occurred_at,
  content,
  amount_yuan,
  created_at,
  updated_at
`;

/** 公开收支流水的类型。 */
export type PublicFinancialLedgerEntryType = 'income' | 'expense';

/** 公开收支流水的数据库行。 */
export interface PublicFinancialLedgerEntryRow {
  id: string;
  entry_type: PublicFinancialLedgerEntryType;
  occurred_at: string;
  content: string;
  amount_yuan: number;
  created_at: string;
  updated_at: string;
}

/** 创建或更新公开收支流水时允许写入的字段。 */
export interface PublicFinancialLedgerEntryInput {
  entryType: PublicFinancialLedgerEntryType;
  occurredAt: string;
  content: string;
  amountYuan: number;
}

function normalizePublicLedgerRow(
  row: PublicFinancialLedgerEntryRow,
): PublicFinancialLedgerEntryRow {
  return {
    ...row,
    amount_yuan: Number(row.amount_yuan),
  };
}

/**
 * 读取公开收支流水。
 *
 * 按发生日期倒序返回，供关于页面和后台列表复用。
 */
export async function listPublicFinancialLedgerEntries(): Promise<
  PublicFinancialLedgerEntryRow[]
> {
  const { rows } = await pool.query<PublicFinancialLedgerEntryRow>(
    `SELECT ${PUBLIC_LEDGER_COLUMNS}
     FROM public_financial_ledger_entries
     ORDER BY occurred_at DESC, created_at DESC`,
  );
  return rows.map(normalizePublicLedgerRow);
}

/**
 * 新增公开收支流水。
 *
 * 由后台维护，写入后会立即返回标准化后的数据库行。
 */
export async function createPublicFinancialLedgerEntry(
  input: PublicFinancialLedgerEntryInput,
): Promise<PublicFinancialLedgerEntryRow> {
  const { rows } = await pool.query<PublicFinancialLedgerEntryRow>(
    `INSERT INTO public_financial_ledger_entries (
       id, entry_type, occurred_at, content, amount_yuan
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_LEDGER_COLUMNS}`,
    [
      `public-ledger-${randomUUID()}`,
      input.entryType,
      input.occurredAt,
      input.content,
      input.amountYuan,
    ],
  );
  return normalizePublicLedgerRow(rows[0]!);
}

/**
 * 更新公开收支流水。
 *
 * 找不到记录时返回 null，调用方负责转换成 404。
 */
export async function updatePublicFinancialLedgerEntry(
  id: string,
  input: PublicFinancialLedgerEntryInput,
): Promise<PublicFinancialLedgerEntryRow | null> {
  const { rows } = await pool.query<PublicFinancialLedgerEntryRow>(
    `UPDATE public_financial_ledger_entries
     SET entry_type = $2,
         occurred_at = $3,
         content = $4,
         amount_yuan = $5,
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${PUBLIC_LEDGER_COLUMNS}`,
    [id, input.entryType, input.occurredAt, input.content, input.amountYuan],
  );
  return rows[0] ? normalizePublicLedgerRow(rows[0]) : null;
}

/**
 * 删除公开收支流水。
 *
 * 返回是否实际删除了记录，调用方据此决定是否返回 404。
 */
export async function deletePublicFinancialLedgerEntry(
  id: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM public_financial_ledger_entries WHERE id = $1`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}
