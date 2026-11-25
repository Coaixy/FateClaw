import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './io.js';
import { decodeAgentIpc } from './ipc-security.js';

type InboxEnvelope = [queue: string, encrypted: string];

interface InboxConsumerOptions {
  accountId: string;
  getConcurrency(): Promise<number>;
  pop(
    memberQueue: string,
    queue: string,
    timeoutSeconds: number,
  ): Promise<InboxEnvelope | null>;
  requeue(queue: string, encrypted: string): Promise<unknown>;
  processMessage(raw: string): Promise<void>;
}

export function createInboxConsumer(options: InboxConsumerOptions) {
  const activeTasks = new Set<Promise<void>>();
  let stopping = false;
  let receiveLoop: Promise<void> | undefined;

  async function waitForCapacity(): Promise<void> {
    while (!stopping) {
      const limit = await options.getConcurrency();
      if (stopping || activeTasks.size < limit) return;
      await Promise.race([...activeTasks, sleep(250)]);
    }
  }

  async function consume(): Promise<void> {
    const normalQueue = `ipc:${options.accountId}:inbox`;
    const memberQueue = `${normalQueue}:member`;
    let pendingEnvelope: InboxEnvelope | null = null;
    while (!stopping) {
      try {
        await waitForCapacity();
        if (stopping) break;

        pendingEnvelope ??= await options.pop(memberQueue, normalQueue, 1);
        if (!pendingEnvelope) continue;

        // Account policy can change while BRPOP is waiting.
        await waitForCapacity();
        if (stopping) break;

        const [queue, encrypted] = pendingEnvelope;
        pendingEnvelope = null;
        const raw = decodeAgentIpc(queue, encrypted);
        const task = options
          .processMessage(raw)
          .catch((error) => {
            log(
              `收件箱任务异常结束: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            activeTasks.delete(task);
          });
        // A redelivery can present the same requestId while the original still owns execution.
        activeTasks.add(task);
      } catch (error) {
        log(
          `常驻循环出错: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!stopping) await sleep(1_000);
      }
    }
    if (pendingEnvelope) {
      await options.requeue(...pendingEnvelope);
    }
  }

  return {
    run() {
      return (receiveLoop ??= consume());
    },
    async stopAndDrain(timeoutMs: number): Promise<void> {
      stopping = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          // Wait for an outstanding BRPOP to return its envelope before the daemon closes Redis.
          Promise.allSettled([receiveLoop, ...activeTasks]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
