import { randomUUID } from 'node:crypto';
import { getAgentDbPool } from './agent-db.js';
import { log } from './io.js';
import {
  spoolResult,
  removeSpooledResult,
  readSpooledResults,
  type ResultRouting,
} from './result-spool.js';
import type { InboxRequest, OutboxResponse } from './types.js';

const workerId = randomUUID();

/** Missing executionId denotes an in-flight request from the previous host version. */
export async function claimDurableExecution(
  request: InboxRequest,
): Promise<boolean> {
  if (!request.executionId) return true;
  const result = await getAgentDbPool().query(
    `UPDATE agent_requests SET state='running',lease_owner=$4,
       lease_until=now()+interval '60 seconds',updated_at=now()
     WHERE request_id=$1 AND execution_id=$2 AND account_id=$3
       AND state IN ('queued','dispatched') AND cancel_requested_at IS NULL
       AND deadline_at>now()`,
    [request.requestId, request.executionId, request.accountId, workerId],
  );
  return result.rowCount === 1;
}

export function startDurableExecutionHeartbeat(
  request: InboxRequest,
  abort: () => void,
): () => void {
  if (!request.executionId) return () => {};
  let stopped = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const result = await getAgentDbPool().query(
        `UPDATE agent_requests SET lease_until=now()+interval '60 seconds'
         WHERE request_id=$1 AND execution_id=$2 AND account_id=$3
           AND lease_owner=$4 AND state='running'
         RETURNING cancel_requested_at IS NOT NULL OR deadline_at<=now() AS cancelled`,
        [request.requestId, request.executionId, request.accountId, workerId],
      );
      if (!stopped && (!result.rowCount || result.rows[0]?.cancelled)) abort();
    } catch {
      // Stop generation when ownership cannot be renewed; recovery must not rerun it.
      if (!stopped) abort();
      log(
        `Durable execution lease renewal failed requestId=${request.requestId}`,
      );
    } finally {
      busy = false;
    }
  }, 10_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** A generated response must never turn into a generic failure because transport failed. */
export async function deliverDurableResult(
  request: ResultRouting,
  response: OutboxResponse,
  push: (queue: string, payload: string) => Promise<unknown>,
): Promise<void> {
  let file: string | undefined;
  try {
    file = await spoolResult(request, response);
  } catch {
    log(`Result local persistence failed requestId=${request.requestId}`);
  }
  const delivered = await transmitResult(request, response, push);
  if (delivered && file) await removeSpooledResult(file);
  if (!delivered && !file)
    throw new Error('Generated result could not be persisted or delivered');
}

async function transmitResult(
  request: ResultRouting,
  response: OutboxResponse,
  push: (queue: string, payload: string) => Promise<unknown>,
): Promise<boolean> {
  let persisted = false;
  const synthetic =
    (response.metadata as { synthetic_terminal?: boolean } | undefined)
      ?.synthetic_terminal === true;
  if (request.executionId) {
    try {
      const result = await getAgentDbPool().query(
        `UPDATE agent_requests SET state=$5,result=$4,
           lease_until=NULL,updated_at=now()
         WHERE request_id=$1 AND execution_id=$2 AND account_id=$3
           AND state IN ('running','interrupted') AND (result IS NULL OR state='interrupted')`,
        [
          request.requestId,
          request.executionId,
          request.accountId,
          JSON.stringify(response),
          synthetic ? 'interrupted' : 'result_ready',
        ],
      );
      if (!result.rowCount) {
        const { rows } = await getAgentDbPool().query(
          'SELECT execution_id,account_id,state FROM agent_requests WHERE request_id=$1',
          [request.requestId],
        );
        const current = rows[0];
        return Boolean(
          current &&
          (current.execution_id !== request.executionId ||
            current.account_id !== request.accountId ||
            current.state === 'result_ready' ||
            current.state === 'completed'),
        );
      }
      persisted = true;
    } catch {
      log(
        `Durable result persistence failed; attempting IPC delivery requestId=${request.requestId}`,
      );
    }
  }
  try {
    await push(
      request.outboxQueue ?? `ipc:${request.accountId}:outbox`,
      JSON.stringify(response),
    );
    return true;
  } catch {
    log(
      `Result IPC delivery failed requestId=${request.requestId} persisted=${persisted}`,
    );
    return persisted;
  }
}

export async function replayDurableResults(
  accountId: string,
  push: (queue: string, payload: string) => Promise<unknown>,
): Promise<void> {
  for (const { file, result } of await readSpooledResults(accountId)) {
    if (await transmitResult(result.request, result.response, push))
      await removeSpooledResult(file);
  }
}
