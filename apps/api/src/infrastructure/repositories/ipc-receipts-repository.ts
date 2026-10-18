import { getDbPool } from '../db-pool.js';

export async function claimOutboundIpcReceipt(
  accountId: string,
  receiptId: string,
): Promise<boolean> {
  const { rows } = await getDbPool().query<{ claimed: boolean }>(
    "SELECT claim_runtime_ipc_receipt($1,'outbox',$2) AS claimed",
    [accountId, receiptId],
  );
  return rows[0]?.claimed === true;
}
