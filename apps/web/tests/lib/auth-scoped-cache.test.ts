import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthScopedCaches,
  createAuthScopedInFlightCache,
} from '../../lib/auth-scoped-cache';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function createPendingPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

describe('auth-scoped in-flight cache', () => {
  afterEach(() => {
    clearAuthScopedCaches();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not reuse an in-flight promise after token switches', () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    storage.setItem('token', 'token-a');

    const cache = createAuthScopedInFlightCache<string>();
    const firstRequest = createPendingPromise<string>();
    const secondRequest = createPendingPromise<string>();
    const createRequest = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    const firstPromise = cache.get(createRequest);

    expect(cache.get(createRequest)).toBe(firstPromise);
    expect(createRequest).toHaveBeenCalledTimes(1);

    storage.setItem('token', 'token-b');

    const secondPromise = cache.get(createRequest);

    expect(secondPromise).not.toBe(firstPromise);
    expect(createRequest).toHaveBeenCalledTimes(2);
  });

  it('drops the in-flight request when clearing caches for the same token', () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    storage.setItem('token', 'same-token');

    const cache = createAuthScopedInFlightCache<string>();
    const firstRequest = createPendingPromise<string>();
    const secondRequest = createPendingPromise<string>();
    const createRequest = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    const firstPromise = cache.get(createRequest);

    clearAuthScopedCaches();

    const secondPromise = cache.get(createRequest);

    expect(secondPromise).not.toBe(firstPromise);
    expect(createRequest).toHaveBeenCalledTimes(2);
  });

  it('reuses successful snapshots until they expire and can request fresh data', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    storage.setItem('token', 'token-a');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const cache = createAuthScopedInFlightCache<string>({ maxAgeMs: 100 });
    const request = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('manual refresh')
      .mockResolvedValueOnce('after expiry');

    await expect(cache.get(request)).resolves.toBe('first');
    expect(cache.peek()).toBe('first');
    await expect(cache.get(request)).resolves.toBe('first');
    expect(request).toHaveBeenCalledTimes(1);

    await expect(cache.get(request, { refresh: true })).resolves.toBe('manual refresh');
    now.mockReturnValue(1_100);
    expect(cache.peek()).toBeUndefined();
    await expect(cache.get(request)).resolves.toBe('after expiry');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('never refills a cleared snapshot from a request that finishes late', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    storage.setItem('token', 'token-a');
    const cache = createAuthScopedInFlightCache<string>({ maxAgeMs: 30_000 });
    const oldRequest = createPendingPromise<string>();
    const original = cache.get(() => oldRequest.promise);

    cache.clear();
    await expect(cache.get(async () => 'current')).resolves.toBe('current');
    oldRequest.resolve('stale');
    await original;
    expect(cache.peek()).toBe('current');

    storage.setItem('token', 'token-b');
    expect(cache.peek()).toBeUndefined();
    await expect(cache.get(async () => 'other user')).resolves.toBe('other user');
    storage.removeItem('token');
    expect(cache.peek()).toBeUndefined();
  });

  it('caches neither anonymous responses nor failed requests', async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    const cache = createAuthScopedInFlightCache<string>({ maxAgeMs: 30_000 });

    await cache.get(async () => 'anonymous');
    expect(cache.peek()).toBeUndefined();

    storage.setItem('token', 'token-a');
    const request = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('back online');
    await expect(cache.get(request)).rejects.toThrow('offline');
    expect(cache.peek()).toBeUndefined();
    await expect(cache.get(request)).resolves.toBe('back online');
  });
});
