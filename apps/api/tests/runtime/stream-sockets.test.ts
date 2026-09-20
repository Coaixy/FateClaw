import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachStreamSocket,
  StreamSubscriptions,
} from '../../src/runtime/stream-sockets.js';

function subscriber() {
  return Object.assign(new EventEmitter(), {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(0),
    disconnect: vi.fn(),
  });
}
function socket() {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((_message: string, callback: (err?: Error) => void) =>
      callback(),
    ),
    ping: vi.fn(),
    terminate: vi.fn(),
  });
  ws.terminate.mockImplementation(() => {
    ws.readyState = 3;
    ws.emit('close');
  });
  return ws;
}
const snapshot = (text: string) =>
  JSON.stringify({
    type: 'assistant_delta',
    requestId: 'r',
    turnIndex: 1,
    delta: text,
    snapshot: text,
  });
afterEach(() => vi.useRealTimers());

describe('bounded stream sockets', () => {
  it('coalesces only matching snapshots while backpressured and drains the latest', async () => {
    vi.useFakeTimers();
    const redis = subscriber();
    const hub = new StreamSubscriptions(() => redis as unknown as Redis);
    const ws = socket();
    attachStreamSocket(ws as unknown as WebSocket, hub, 'channel', 'connected');
    await vi.advanceTimersByTimeAsync(0);
    ws.send.mockClear();
    ws.bufferedAmount = 1024 * 1024;
    redis.emit('message', 'channel', snapshot('old'));
    redis.emit('message', 'channel', snapshot('latest'));
    expect(ws.send).not.toHaveBeenCalled();
    ws.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send.mock.calls[0][0]).toBe(snapshot('latest'));
    hub.close();
  });

  it('disconnects instead of dropping a final event behind a pending snapshot', async () => {
    vi.useFakeTimers();
    const redis = subscriber();
    const hub = new StreamSubscriptions(() => redis as unknown as Redis);
    const ws = socket();
    attachStreamSocket(ws as unknown as WebSocket, hub, 'channel', 'connected');
    await vi.advanceTimersByTimeAsync(0);
    ws.bufferedAmount = 1024 * 1024;
    redis.emit('message', 'channel', snapshot('pending'));
    redis.emit(
      'message',
      'channel',
      JSON.stringify({ type: 'final', text: 'done' }),
    );
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.unsubscribe).toHaveBeenCalledWith('channel');
    hub.close();
  });

  it('terminates clients that stop answering heartbeat pings', async () => {
    vi.useFakeTimers();
    const redis = subscriber();
    const hub = new StreamSubscriptions(() => redis as unknown as Redis);
    const ws = socket();
    attachStreamSocket(ws as unknown as WebSocket, hub, 'channel', 'connected');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    ws.emit('pong');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    hub.close();
  });

  it('releases a socket closed while the subscription is pending', async () => {
    const redis = subscriber();
    let complete!: () => void;
    redis.subscribe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const hub = new StreamSubscriptions(() => redis as unknown as Redis);
    const ws = socket();
    attachStreamSocket(ws as unknown as WebSocket, hub, 'channel', 'connected');
    await vi.waitFor(() => expect(redis.subscribe).toHaveBeenCalled());
    ws.emit('close');
    complete();
    await vi.waitFor(() =>
      expect(redis.unsubscribe).toHaveBeenCalledWith('channel'),
    );
    expect(ws.send).not.toHaveBeenCalled();
    hub.close();
  });

  it('does not leave subscribed channels after a failed subscription', async () => {
    const redis = subscriber();
    redis.subscribe.mockRejectedValueOnce(
      new Error('subscription unavailable'),
    );
    const hub = new StreamSubscriptions(() => redis as unknown as Redis);
    const failed = socket();
    attachStreamSocket(
      failed as unknown as WebSocket,
      hub,
      'channel',
      'connected',
    );
    await vi.waitFor(() => expect(failed.terminate).toHaveBeenCalledTimes(1));
    const retried = socket();
    attachStreamSocket(
      retried as unknown as WebSocket,
      hub,
      'channel',
      'connected',
    );
    await vi.waitFor(() =>
      expect(retried.send).toHaveBeenCalledWith(
        'connected',
        expect.any(Function),
      ),
    );
    expect(redis.subscribe).toHaveBeenCalledTimes(2);
    hub.close();
  });

  it('forces browser reconciliation when the subscriber disconnects', async () => {
    const redis = subscriber();
    const hub = new StreamSubscriptions(() => redis as unknown as Redis);
    const ws = socket();
    attachStreamSocket(ws as unknown as WebSocket, hub, 'channel', 'connected');
    await vi.waitFor(() => expect(redis.subscribe).toHaveBeenCalled());
    redis.emit('close');
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    hub.close();
  });
});
