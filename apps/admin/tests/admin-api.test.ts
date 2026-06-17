import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { admin, clearAdminKey, setAdminKey } from '@/lib/admin-api';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('admin API additions', () => {
  let sessionStorage: MemoryStorage;
  let localStorage: MemoryStorage;

  beforeEach(() => {
    sessionStorage = new MemoryStorage();
    localStorage = new MemoryStorage();
    vi.stubGlobal('window', {
      sessionStorage,
      localStorage,
    });
    setAdminKey('owner-test-key');
  });

  afterEach(() => {
    clearAdminKey();
    vi.unstubAllGlobals();
  });

  test('userBalanceGrants 拼接正确路径', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await admin.userBalanceGrants('user123', { limit: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/users/user123/balance/grants?limit=20',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Admin-Key': 'owner-test-key',
        }),
      }),
    );
  });

  test('reconcileBillingReservations 使用 POST 请求', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ released: 1, requestIds: ['req_1'] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await admin.reconcileBillingReservations({
      stale_ms: 3_600_000,
      limit: 50,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/billing/reconcile',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ stale_ms: 3_600_000, limit: 50 }),
        headers: expect.objectContaining({
          'X-Admin-Key': 'owner-test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});
