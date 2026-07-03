import type pg from 'pg';

import type { DatabaseMigration } from '../types.js';
import { deleteUsersWithoutValidPhone } from '../../phone-only-user-migration.js';

/**
 * 一次性清理「无有效手机号」的历史脏用户及其关联数据。
 *
 * @remarks
 * 该删除逻辑原本被无条件放在每次进程启动路径（`db.ts` 的 `initDatabase`），
 * 本质是「手机号改造」上线时的一次性数据迁移，却被误当成永久启动逻辑：
 * 一旦守卫条件（大陆手机号正则 / OAuth 身份保留）被改动，或某类合法用户落入删除集，
 * 每次重启都会静默批量硬删除用户及其账务数据，是不可回溯的定时炸弹。
 *
 * 此处将其正式纳入迁移体系，借助 `schema_migrations` 幂等 + advisory lock 只执行一次，
 * 且整个删除跑在迁移的单一事务内（失败即回滚，具备原来 autocommit 逐语句执行所没有的原子性）。
 * 删除逻辑本身（含 OAuth 身份保留守卫与删除前计数告警）保持不变。
 *
 * 编号说明：基线已压平历史 0001-0067，远程 ledger 另有 0068-0070，故从 0071 续号。
 */
export const cleanupInvalidPhoneUsersMigrations: DatabaseMigration[] = [
  {
    id: '0071_cleanup_invalid_phone_users',
    description: '一次性清理无有效手机号的历史脏用户及其关联数据',
    up: async (client: pg.PoolClient): Promise<void> => {
      await deleteUsersWithoutValidPhone(client);
    },
  },
];
