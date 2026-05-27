import type { QueryResult, QueryResultRow } from 'pg';

import type { DbQueryable } from './db-pool.js';

export type DbQueryParams = readonly unknown[];

export async function queryResult<Row extends QueryResultRow>(
  queryable: DbQueryable,
  sql: string,
  params: DbQueryParams = [],
): Promise<QueryResult<Row>> {
  return queryable.query<Row>(sql, [...params]);
}

export async function queryRows<Row extends QueryResultRow>(
  queryable: DbQueryable,
  sql: string,
  params: DbQueryParams = [],
): Promise<Row[]> {
  const { rows } = await queryResult<Row>(queryable, sql, params);
  return rows;
}

export async function queryOne<Row extends QueryResultRow>(
  queryable: DbQueryable,
  sql: string,
  params: DbQueryParams = [],
): Promise<Row | undefined> {
  const rows = await queryRows<Row>(queryable, sql, params);
  return rows[0];
}
