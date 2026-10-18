import type { Redis } from 'ioredis';
import { getRedis } from '#infrastructure/redis';
import { logger } from '#infrastructure/logger';

export const CAPACITY_CHANNEL = 'agent:capacity:changed';

class CapacitySignal {
  revision = 0;
  private readonly waiters = new Set<() => void>();
  private subscriber: Redis | null = null;
  private connecting: Promise<void> | null = null;

  private async subscribe(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.subscriber) return;
    const task = (async () => {
      let subscriber: Redis | undefined;
      try {
        subscriber = getRedis().duplicate({ commandTimeout: 5_000 });
        this.subscriber = subscriber;
        subscriber.on('message', (channel) => {
          if (channel === CAPACITY_CHANNEL) this.notify();
        });
        subscriber.on('error', () => {});
        await subscriber.connect();
        if (this.subscriber !== subscriber) {
          subscriber.disconnect();
          return;
        }
        await subscriber.subscribe(CAPACITY_CHANNEL);
        this.notify();
      } catch {
        subscriber?.disconnect();
        if (this.subscriber === subscriber) this.subscriber = null;
        logger.warn(
          'Capacity notifications unavailable; using finite reconciliation',
        );
      }
    })();
    this.connecting = task;
    try {
      await task;
    } finally {
      if (this.connecting === task) this.connecting = null;
    }
  }

  async wait(timeoutMs: number, revision = this.revision): Promise<void> {
    await this.subscribe();
    if (revision !== this.revision) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.add(wake);
    });
  }

  notify(): void {
    this.revision += 1;
    for (const wake of this.waiters) wake();
  }

  reset(): void {
    this.subscriber?.disconnect();
    this.subscriber = null;
    this.connecting = null;
    this.notify();
  }
}

// Notifications are hints; finite lease reconciliation remains authoritative.
export const capacityChanged = new CapacitySignal();
