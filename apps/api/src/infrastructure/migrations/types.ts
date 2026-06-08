import type pg from 'pg';

/**
 * 单个数据库迁移定义。
 */
export interface DatabaseMigration {
  id: string;
  description: string;
  up(client: pg.PoolClient): Promise<void>;
}
