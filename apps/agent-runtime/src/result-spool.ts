import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { resolvePiSessionDir } from '#agent/pi-runtime/session-manager';
import type { InboxRequest, OutboxResponse } from './types.js';

export type ResultRouting = Pick<
  InboxRequest,
  'requestId' | 'executionId' | 'accountId' | 'outboxQueue'
>;
export interface SpooledResult {
  request: ResultRouting;
  response: OutboxResponse;
}
function directory(accountId: string): string {
  return path.join(
    resolvePiSessionDir(process.cwd()),
    'result-outbox',
    createHash('sha256').update(accountId).digest('hex'),
  );
}
export async function spoolResult(
  request: ResultRouting,
  response: OutboxResponse,
): Promise<string> {
  const dir = directory(request.accountId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // A replay acknowledgement must not unlink a newer response for the same execution.
  const serialized = JSON.stringify({
    request: {
      requestId: request.requestId,
      executionId: request.executionId,
      accountId: request.accountId,
      outboxQueue: request.outboxQueue,
    },
    response,
  } satisfies SpooledResult);
  const file = path.join(
    dir,
    createHash('sha256').update(serialized).digest('hex') + '.json',
  );
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  const folder = await open(dir, 'r');
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
  return file;
}
export async function removeSpooledResult(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
export async function readSpooledResults(
  accountId: string,
): Promise<Array<{ file: string; result: SpooledResult }>> {
  const dir = directory(accountId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const results: Array<{ file: string; result: SpooledResult }> = [];
  for (const name of names
    .filter((name) => name.endsWith('.json'))
    .slice(0, 16)) {
    const file = path.join(dir, name);
    const result = JSON.parse(await readFile(file, 'utf8')) as SpooledResult;
    if (result.request.accountId !== accountId)
      throw new Error('Spooled result account mismatch');
    results.push({ file, result });
  }
  return results;
}
