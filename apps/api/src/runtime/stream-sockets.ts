import type { Redis } from 'ioredis';
import type WebSocket from 'ws';
import { logger } from '../infrastructure/logger.js';

const MAX_BUFFER_BYTES = 1024 * 1024;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const DRAIN_INTERVAL_MS = 50;

type Listener = { send: (message: string) => void; disconnect: () => void };

/** One subscriber per API instance; channel membership follows live sockets. */
export class StreamSubscriptions {
  private subscriber?: Redis;
  private connected?: Promise<void>;
  private channels = new Map<string, Set<Listener>>();
  private operations = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(private readonly createSubscriber: () => Redis) {}

  private connection(): Promise<void> {
    if (!this.connected) {
      const subscriber = this.createSubscriber();
      this.subscriber = subscriber;
      subscriber.on('message', (channel, message) => {
        for (const listener of this.channels.get(channel) ?? [])
          listener.send(message);
      });
      subscriber.on('error', (err) =>
        logger.warn({ err }, 'Chat stream subscriber error'),
      );
      // Pub/sub has no replay. Reconnect browsers so polling reconciles any gap.
      subscriber.on('close', () => {
        for (const listeners of this.channels.values()) {
          for (const listener of [...listeners]) listener.disconnect();
        }
      });
      this.connected = subscriber
        .connect()
        .then(() => undefined)
        .catch((err) => {
          subscriber.disconnect();
          this.connected = undefined;
          this.subscriber = undefined;
          throw err;
        });
    }
    return this.connected;
  }

  private enqueue(
    channel: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const next = (this.operations.get(channel) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.operations.set(channel, next);
    void next
      .finally(() => {
        if (this.operations.get(channel) === next)
          this.operations.delete(channel);
      })
      .catch(() => {});
    return next;
  }

  add(
    channel: string,
    listener: Listener,
  ): { ready: Promise<void>; release: () => void } {
    if (this.closed)
      return {
        ready: Promise.reject(new Error('Stream subscriber closed')),
        release() {},
      };
    let listeners = this.channels.get(channel);
    const first = !listeners;
    if (!listeners) this.channels.set(channel, (listeners = new Set()));
    listeners.add(listener);
    const ready = first
      ? this.enqueue(channel, async () => {
          if (this.closed) throw new Error('Stream subscriber closed');
          await this.connection();
          await this.subscriber!.subscribe(channel);
        })
      : (this.operations.get(channel) ?? Promise.resolve()).then(
          () => undefined,
        );
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        listeners.delete(listener);
        if (listeners.size || this.channels.get(channel) !== listeners) return;
        this.channels.delete(channel);
        void this.enqueue(channel, async () => {
          if (!this.closed && this.subscriber)
            await this.subscriber.unsubscribe(channel);
        }).catch((err) =>
          logger.warn({ err }, 'Chat stream unsubscribe failed'),
        );
      },
    };
  }

  close(): void {
    this.closed = true;
    for (const listeners of this.channels.values()) {
      for (const listener of [...listeners]) listener.disconnect();
    }
    this.channels.clear();
    // Shutdown must not wait for Redis to become reachable again.
    this.subscriber?.disconnect();
  }
}

export function attachStreamSocket(
  socket: WebSocket,
  subscriptions: StreamSubscriptions,
  channel: string,
  connectedMessage: string,
  decode?: (message: string) => string | null,
): void {
  let closed = false;
  let lastPongAt = Date.now();
  let pending: { key: string; message: string } | undefined;
  let pendingSince = 0;
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  let release = () => {};
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    clearInterval(drainTimer);
    pending = undefined;
    release();
    socket.terminate();
  };
  const write = (message: string) => {
    socket.send(message, (err) => {
      if (err) stop();
    });
  };
  const send = (message: string) => {
    if (closed || socket.readyState !== 1) return;
    const bytes = Buffer.byteLength(message);
    if (bytes > MAX_BUFFER_BYTES) {
      stop();
      return;
    }
    if (!pending && socket.bufferedAmount + bytes <= MAX_BUFFER_BYTES) {
      write(message);
      return;
    }
    let event: {
      type?: string;
      requestId?: string;
      turnIndex?: number;
      snapshot?: string;
    };
    try {
      event = JSON.parse(message);
    } catch {
      stop();
      return;
    }
    if (
      !['assistant_delta', 'thinking_delta'].includes(event.type ?? '') ||
      typeof event.snapshot !== 'string'
    ) {
      stop();
      return;
    }
    const key = `${event.requestId}:${event.turnIndex}:${event.type}`;
    // Only replace the same full snapshot; never reorder turn/tool/final boundaries.
    if (pending && pending.key !== key) {
      stop();
      return;
    }
    if (!pending) pendingSince = Date.now();
    pending = { key, message };
    if (!drainTimer) {
      drainTimer = setInterval(() => {
        if (!pending || socket.readyState !== 1) return;
        if (Date.now() - pendingSince >= PING_INTERVAL_MS) {
          stop();
          return;
        }
        if (
          socket.bufferedAmount + Buffer.byteLength(pending.message) >
          MAX_BUFFER_BYTES
        )
          return;
        const latest = pending.message;
        pending = undefined;
        clearInterval(drainTimer);
        drainTimer = undefined;
        write(latest);
      }, DRAIN_INTERVAL_MS);
      drainTimer.unref();
    }
  };
  const pingTimer = setInterval(() => {
    if (
      Date.now() - lastPongAt >= PONG_TIMEOUT_MS ||
      socket.bufferedAmount >= MAX_BUFFER_BYTES
    ) {
      stop();
      return;
    }
    socket.ping(undefined, undefined, (err: Error | undefined) => {
      if (err) stop();
    });
  }, PING_INTERVAL_MS);
  pingTimer.unref();
  socket.on('pong', () => {
    lastPongAt = Date.now();
  });
  socket.on('close', stop);
  socket.on('error', stop);
  const subscription = subscriptions.add(channel, {
    send(message) {
      try {
        const plaintext = decode ? decode(message) : message;
        if (plaintext !== null) send(plaintext);
      } catch {
        logger.warn({ channel }, 'Unauthenticated chat stream event discarded');
      }
    },
    disconnect: stop,
  });
  release = subscription.release;
  void subscription.ready
    .then(() => {
      if (closed) release();
      else send(connectedMessage);
    })
    .catch((err) => {
      logger.warn({ err }, 'Chat stream subscription failed');
      stop();
    });
}
