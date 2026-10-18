import type { DatabaseMigration } from '../types.js';

export const runtimeIpcReceiptsMigration: DatabaseMigration = {
  id: '0097_runtime_ipc_receipts',
  description: 'Fence replay of legacy runtime execution and external delivery',
  async up(client) {
    await client.query(`
      CREATE TABLE runtime_ipc_receipts (
        account_id text NOT NULL,
        direction text NOT NULL CHECK (direction IN ('inbox','outbox')),
        receipt_id text NOT NULL,
        expires_at timestamptz NOT NULL DEFAULT now()+interval '25 hours',
        PRIMARY KEY (account_id,direction,receipt_id)
      );
      CREATE INDEX runtime_ipc_receipts_expiry ON runtime_ipc_receipts(expires_at);
      CREATE FUNCTION claim_runtime_ipc_receipt(p_account text,p_direction text,p_id text)
      RETURNS boolean LANGUAGE plpgsql AS $fn$
      BEGIN
        IF p_account IS NULL OR p_id IS NULL OR length(p_id)>512 OR length(p_id)=0
          OR p_direction IS NULL OR p_direction NOT IN ('inbox','outbox') THEN RETURN false; END IF;
        WITH expired AS (
          SELECT account_id,direction,receipt_id FROM runtime_ipc_receipts
          WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
        ) DELETE FROM runtime_ipc_receipts receipt USING expired
          WHERE receipt.account_id=expired.account_id AND receipt.direction=expired.direction
            AND receipt.receipt_id=expired.receipt_id;
        INSERT INTO runtime_ipc_receipts(account_id,direction,receipt_id)
          VALUES(p_account,p_direction,p_id) ON CONFLICT DO NOTHING;
        RETURN FOUND;
      END $fn$;
    `);
  },
};
