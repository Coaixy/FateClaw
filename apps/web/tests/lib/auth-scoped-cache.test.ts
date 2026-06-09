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

  it('advances the auth cache epoch when clearing scoped caches', () => {
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
});
