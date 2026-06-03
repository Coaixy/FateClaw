import { Account } from '../../shared/types.js';
import { getDbPool } from '../db-pool.js';

export async function createAccount(account: Account): Promise<void> {
  await getDbPool().query(
    `INSERT INTO accounts (id, user_id, name, bot_token, base_url, get_updates_buf, enabled, created_at, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      account.id,
      account.user_id,
      account.name,
      account.bot_token,
      account.base_url,
      account.get_updates_buf,
      account.enabled,
      account.created_at,
      account.owner_id ?? null,
    ],
  );
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM accounts WHERE id = $1',
    [id],
  );
  return rows[0] as Account | undefined;
}

export async function getAllAccounts(): Promise<Account[]> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM accounts ORDER BY created_at',
  );
  return rows as Account[];
}

export async function getEnabledAccounts(): Promise<Account[]> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM accounts WHERE enabled = true ORDER BY created_at',
  );
  return rows as Account[];
}

export async function getAccountsByUserId(userId: string): Promise<Account[]> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM accounts WHERE owner_id = $1 ORDER BY created_at',
    [userId],
  );
  return rows as Account[];
}

export async function getSoulContent(accountId: string): Promise<string> {
  const { rows } = await getDbPool().query(
    'SELECT soul_content FROM accounts WHERE id = $1',
    [accountId],
  );
  return (rows[0] as { soul_content: string } | undefined)?.soul_content ?? '';
}

export async function updateSoulContent(
  accountId: string,
  content: string,
): Promise<void> {
  await getDbPool().query(
    'UPDATE accounts SET soul_content = $1 WHERE id = $2',
    [content, accountId],
  );
}

export async function updateAccount(
  id: string,
  updates: Partial<
    Pick<
      Account,
      'name' | 'bot_token' | 'base_url' | 'get_updates_buf' | 'enabled'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIdx++}`);
    values.push(updates.name);
  }
  if (updates.bot_token !== undefined) {
    fields.push(`bot_token = $${paramIdx++}`);
    values.push(updates.bot_token);
  }
  if (updates.base_url !== undefined) {
    fields.push(`base_url = $${paramIdx++}`);
    values.push(updates.base_url);
  }
  if (updates.get_updates_buf !== undefined) {
    fields.push(`get_updates_buf = $${paramIdx++}`);
    values.push(updates.get_updates_buf);
  }
  if (updates.enabled !== undefined) {
    fields.push(`enabled = $${paramIdx++}`);
    values.push(updates.enabled);
  }

  if (fields.length === 0) return;
  values.push(id);
  await getDbPool().query(
    `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

export async function bindAccountToUser(
  accountId: string,
  userId: string,
): Promise<void> {
  await getDbPool().query('UPDATE accounts SET owner_id = $1 WHERE id = $2', [
    userId,
    accountId,
  ]);
}

export async function deleteAccount(id: string): Promise<void> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM conversation_logs WHERE account_id = $1', [
      id,
    ]);
    await client.query('DELETE FROM messages WHERE account_id = $1', [id]);
    // chat_sessions.account_id 是 NOT NULL FK，必须先删除会话。
    await client.query('DELETE FROM chat_sessions WHERE account_id = $1', [id]);
    await client.query('DELETE FROM accounts WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
