import { getDbPool } from '#infrastructure/db-pool';
import { getRedis } from '#infrastructure/redis';

/** Cross-store upgrade work is retryable until its database receipt commits. */
export async function runRuntimeUpgrades(): Promise<void> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT task_key FROM runtime_upgrade_tasks
       WHERE task_key='legacy_concurrency_wait_lists' AND completed_at IS NULL FOR UPDATE`,
    );
    if (rows.length) {
      await getRedis().del(
        'agent:concurrency:wait:member',
        'agent:concurrency:wait:normal',
      );
      await client.query(
        "UPDATE runtime_upgrade_tasks SET completed_at=clock_timestamp() WHERE task_key='legacy_concurrency_wait_lists'",
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
