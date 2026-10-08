import type pg from 'pg';

export interface DatabaseMigration {
  readonly id: string;
  readonly description: string;
  up(client: pg.PoolClient): Promise<void>;
}

export interface DatabaseBaseline {
  readonly throughMigrationId: string;
  up(client: pg.PoolClient): Promise<void>;
}
