import { afterEach, expect, it, vi } from 'vitest';

import {
  BILLING_CHANGED_EVENT,
  billingApi,
  clearBillingCache,
} from '@/features/billing/api';
import { clearAuthScopedCaches } from '@/lib/auth-scoped-cache';
import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({ requestJson: vi.fn() }));

afterEach(() => {
  clearAuthScopedCaches();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('reuses recent balances when requested and gets fresh data on refresh and writes', async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', {
    localStorage: { getItem: () => 'test-user-token' },
    dispatchEvent,
  });
  const request = vi.mocked(requestJson)
    .mockResolvedValueOnce({ available_coins: 20 })
    .mockResolvedValueOnce({ available_coins: 15 })
    .mockResolvedValueOnce({ available_coins: 30 });

  await billingApi.status();
  await expect(billingApi.status({ refresh: false })).resolves.toEqual({
    available_coins: 20,
  });
  expect(request).toHaveBeenCalledTimes(1);

  await expect(billingApi.status()).resolves.toEqual({ available_coins: 15 });
  expect(billingApi.readStatusSnapshot()).toEqual({ available_coins: 15 });

  clearBillingCache();
  expect(billingApi.readStatusSnapshot()).toBeUndefined();
  expect(dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: BILLING_CHANGED_EVENT }),
  );
  await expect(billingApi.status({ refresh: false })).resolves.toEqual({
    available_coins: 30,
  });
  expect(request).toHaveBeenCalledTimes(3);
});
