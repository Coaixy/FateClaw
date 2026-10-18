import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type {
  RegistrationInviteDto,
  RegistrationInvitePolicyDto,
  RegistrationInviteSummaryDto,
} from '@fateclaw/contracts/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const repository = vi.hoisted(() => ({
  assertRegistrationInviteValid: vi.fn(),
  createRegistrationInvite: vi.fn(),
  getRegistrationInvitePolicy: vi.fn(),
  getRegistrationInviteSummary: vi.fn(),
  listCompletedRechargeRefunds: vi.fn(),
  listRegistrationInvites: vi.fn(),
  recordCompletedRechargeRefund: vi.fn(),
  revokeRegistrationInvite: vi.fn(),
  saveRegistrationInvitePolicy: vi.fn(),
  updateRegistrationInviteAccount: vi.fn(),
}));
const { fixedWindowRateLimit } = vi.hoisted(() => ({
  fixedWindowRateLimit: vi.fn(),
}));

vi.mock(
  '#infrastructure/repositories/registration-invites-repository',
  () => repository,
);
vi.mock('#interfaces/http/rate-limit', () => ({
  fixedWindowRateLimit,
}));

import {
  adminRegistrationInviteRoutes,
  registrationInviteRoutes,
} from '#interfaces/http/registration-invite-routes';

const USER_ID = 'synthetic-inviter';
const INVITE_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_KEY = '12345678-abcd-4234-8234-123456789abc';
const INVITE_CODE = '0123456789ABCDEF01234567';
const USER_HEADERS = { authorization: 'Bearer synthetic-user' };
const OWNER_HEADERS = { authorization: 'Bearer synthetic-owner' };
const POLICY: RegistrationInvitePolicyDto = {
  tiers: [
    { threshold_yuan: 30, total_slots: 3 },
    { threshold_yuan: 100, total_slots: 5 },
    { threshold_yuan: 300, total_slots: 10 },
  ],
  expires_in_days: 7,
  revision: 1,
};
const INVITE: RegistrationInviteDto = {
  id: INVITE_ID,
  code_suffix: '234567',
  source: 'user',
  status: 'active',
  created_at: '2026-10-17T00:00:00Z',
  expires_at: '2026-10-24T00:00:00Z',
  used_at: null,
};
const SUMMARY: RegistrationInviteSummaryDto = {
  user_id: USER_ID,
  policy: POLICY,
  net_recharge_yuan: 120,
  eligible: true,
  eligibility_reason: 'eligible',
  total_slots: 5,
  automatic_slots: 5,
  manual_slot_adjustment: 0,
  used_slots: 0,
  reserved_slots: 1,
  available_slots: 4,
  suspended: false,
  revision: 1,
  invitations: [INVITE],
};
const POLICY_UPDATE = {
  tiers: [
    { threshold_yuan: 30, total_slots: 3 },
    { threshold_yuan: 120.5, total_slots: 6 },
    { threshold_yuan: 300, total_slots: 10 },
  ],
  expires_in_days: 14,
  expected_revision: 1,
};
const REFUND = {
  trade_id: 'synthetic-trade',
  amount_yuan: 20.25,
  reference: 'synthetic-completed-refund',
  reason: 'Synthetic completed payment-channel refund',
};

describe('registration invitation HTTP routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    fixedWindowRateLimit.mockResolvedValue({ allowed: true, retryAfterSec: 0 });
    repository.assertRegistrationInviteValid.mockResolvedValue({
      valid: true,
      expires_at: INVITE.expires_at,
    });
    repository.createRegistrationInvite.mockResolvedValue({
      invite: INVITE,
      code: INVITE_CODE,
    });
    repository.getRegistrationInvitePolicy.mockResolvedValue(POLICY);
    repository.getRegistrationInviteSummary.mockResolvedValue(SUMMARY);
    repository.listRegistrationInvites.mockResolvedValue([INVITE]);
    repository.listCompletedRechargeRefunds.mockResolvedValue([]);
    repository.updateRegistrationInviteAccount.mockResolvedValue(SUMMARY);

    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof ZodError ? 400 : (error.statusCode ?? 500))
        .send({ error: error.message }),
    );
    app.decorateRequest('requireAuth', async function (this: FastifyRequest) {
      if (this.headers.authorization !== USER_HEADERS.authorization) {
        throw Object.assign(new Error('Authentication required'), {
          statusCode: 401,
        });
      }
      this.user = { userId: USER_ID };
    });
    app.addHook('onRequest', async (request) => {
      if (request.headers.authorization === OWNER_HEADERS.authorization) {
        request.adminPrincipal = {
          role: 'owner',
          scopes: ['admin:*'],
          home_path: '/admin/overview',
        };
      } else if (
        request.headers.authorization === 'Bearer synthetic-user-manager'
      ) {
        request.adminPrincipal = {
          role: 'user_manager',
          scopes: ['users:read', 'users:create', 'messages:read'],
          home_path: '/admin/users',
        };
      }
    });
    await app.register(registrationInviteRoutes, {
      prefix: '/api/auth/invites',
    });
    await app.register(adminRegistrationInviteRoutes, {
      prefix: '/api/admin/registration-invites',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('offers a rate-limited uncached preview containing only validity and expiry', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/invites/preview',
      payload: { inviteCode: ` ${INVITE_CODE} ` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      valid: true,
      expires_at: INVITE.expires_at,
    });
    expect(repository.assertRegistrationInviteValid).toHaveBeenCalledWith(
      INVITE_CODE,
    );
    expect(fixedWindowRateLimit).toHaveBeenCalledWith(
      'registration:127.0.0.1',
      20,
      600,
    );
    expect(repository.getRegistrationInviteSummary).not.toHaveBeenCalled();
    expect(repository.createRegistrationInvite).not.toHaveBeenCalled();
  });

  it.each([
    { unavailable: false, status: 429 },
    { unavailable: true, status: 503 },
  ])(
    'stops preview before repository access when the limiter returns $status',
    async ({ unavailable, status }) => {
      fixedWindowRateLimit.mockResolvedValueOnce({
        allowed: false,
        retryAfterSec: 30,
        unavailable,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/invites/preview',
        payload: { inviteCode: INVITE_CODE },
      });

      expect(response.statusCode).toBe(status);
      expect(response.headers['retry-after']).toBe('30');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(repository.assertRegistrationInviteValid).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { inviteCode: '   ' }, { inviteCode: 'a'.repeat(65) }])(
    'rejects a missing or malformed preview code: %j',
    async (payload) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/invites/preview',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(repository.assertRegistrationInviteValid).not.toHaveBeenCalled();
    },
  );

  it.each([
    { method: 'GET', url: '/api/auth/invites/me' },
    {
      method: 'POST',
      url: '/api/auth/invites',
      payload: { request_key: REQUEST_KEY },
    },
    { method: 'POST', url: `/api/auth/invites/${INVITE_ID}/revoke` },
  ] as const)('requires a user session for $method $url', async (request) => {
    const response = await app.inject(request);
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    for (const operation of Object.values(repository))
      expect(operation).not.toHaveBeenCalled();
  });

  it('preserves the creation request key on replay without inventing a recoverable code', async () => {
    repository.createRegistrationInvite
      .mockResolvedValueOnce({ invite: INVITE, code: INVITE_CODE })
      .mockResolvedValueOnce({ invite: INVITE, code: null });
    const request = {
      method: 'POST' as const,
      url: '/api/auth/invites',
      headers: USER_HEADERS,
      payload: {
        request_key: REQUEST_KEY.toUpperCase(),
        user_id: 'another-user',
      },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(first.json()).toEqual({ invite: INVITE, code: INVITE_CODE });
    expect(replay.json()).toEqual({ invite: INVITE, code: null });
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(repository.createRegistrationInvite).toHaveBeenNthCalledWith(
      1,
      USER_ID,
      REQUEST_KEY,
    );
    expect(repository.createRegistrationInvite).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      REQUEST_KEY,
    );
  });

  it('uses the authenticated inviter when revoking and refreshing their summary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/auth/invites/${INVITE_ID}/revoke`,
      headers: USER_HEADERS,
      payload: { user_id: 'another-user' },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.revokeRegistrationInvite).toHaveBeenCalledWith(
      INVITE_ID,
      USER_ID,
    );
    expect(repository.getRegistrationInviteSummary).toHaveBeenCalledWith(
      USER_ID,
    );
    expect(response.json()).toEqual(SUMMARY);
  });

  it.each([
    { role: 'anonymous', headers: {} },
    {
      role: 'user manager',
      headers: { authorization: 'Bearer synthetic-user-manager' },
    },
  ])('denies all invitation administration to a $role', async ({ headers }) => {
    const requests = [
      { method: 'GET', url: '/policy' },
      { method: 'PUT', url: '/policy', payload: POLICY_UPDATE },
      { method: 'GET', url: `/users/${USER_ID}` },
      {
        method: 'PATCH',
        url: `/users/${USER_ID}`,
        payload: { total_slots: 4, suspended: true, expected_revision: 1 },
      },
      { method: 'GET', url: '' },
      { method: 'POST', url: '', payload: { request_key: REQUEST_KEY } },
      { method: 'POST', url: `/${INVITE_ID}/revoke` },
      { method: 'GET', url: '/refunds' },
      { method: 'POST', url: '/refunds', payload: REFUND },
    ] as const;
    for (const request of requests) {
      const response = await app.inject({
        ...request,
        url: `/api/admin/registration-invites${request.url}`,
        headers,
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
    for (const operation of Object.values(repository))
      expect(operation).not.toHaveBeenCalled();
  });

  it('allows an owner to update policy with the supplied optimistic revision', async () => {
    const policy: RegistrationInvitePolicyDto = {
      tiers: POLICY_UPDATE.tiers,
      expires_in_days: POLICY_UPDATE.expires_in_days,
      revision: 2,
    };
    repository.saveRegistrationInvitePolicy.mockResolvedValueOnce(policy);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/registration-invites/policy',
      headers: OWNER_HEADERS,
      payload: POLICY_UPDATE,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.saveRegistrationInvitePolicy).toHaveBeenCalledWith(
      POLICY_UPDATE,
    );
    expect(response.json()).toEqual(policy);
  });

  it('allows an owner to change an inviter allowance and suspension together', async () => {
    const update = { total_slots: 5, suspended: true, expected_revision: 7 };
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/registration-invites/users/${USER_ID}`,
      headers: OWNER_HEADERS,
      payload: update,
    });

    expect(response.statusCode).toBe(200);
    expect(repository.updateRegistrationInviteAccount).toHaveBeenCalledWith(
      USER_ID,
      update,
    );
  });

  it('issues owner operational codes without spending a supplied user allowance', async () => {
    const operationalInvite = { ...INVITE, source: 'admin' };
    repository.createRegistrationInvite.mockResolvedValueOnce({
      invite: operationalInvite,
      code: INVITE_CODE,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/registration-invites',
      headers: OWNER_HEADERS,
      payload: { request_key: REQUEST_KEY, user_id: USER_ID },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.createRegistrationInvite).toHaveBeenCalledWith(
      null,
      REQUEST_KEY,
    );
    expect(response.json()).toEqual({
      invite: operationalInvite,
      code: INVITE_CODE,
    });
  });

  it('allows owner revocation without applying a user ownership filter', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/registration-invites/${INVITE_ID}/revoke`,
      headers: OWNER_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(repository.revokeRegistrationInvite).toHaveBeenCalledWith(INVITE_ID);
  });

  it('passes completed refund accounting details through the owner endpoint', async () => {
    const recorded = {
      ...REFUND,
      id: 'synthetic-refund',
      created_at: INVITE.created_at,
    };
    repository.recordCompletedRechargeRefund.mockResolvedValueOnce(recorded);
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/registration-invites/refunds',
      headers: OWNER_HEADERS,
      payload: REFUND,
    });

    expect(response.statusCode).toBe(200);
    expect(repository.recordCompletedRechargeRefund).toHaveBeenCalledWith(
      REFUND,
    );
    expect(response.json()).toEqual(recorded);
  });

  it.each([
    { name: 'missing creation key', method: 'POST', path: '', payload: {} },
    {
      name: 'non-UUID creation key',
      method: 'POST',
      path: '',
      payload: { request_key: 'not-a-uuid' },
    },
    {
      name: 'invalid invitation ID',
      method: 'POST',
      path: '/not-a-uuid/revoke',
      payload: {},
    },
    {
      name: 'fractional cent threshold',
      method: 'PUT',
      path: '/policy',
      payload: {
        ...POLICY_UPDATE,
        tiers: [{ threshold_yuan: 100.001, total_slots: 3 }],
      },
    },
    {
      name: 'missing policy revision',
      method: 'PUT',
      path: '/policy',
      payload: { tiers: POLICY.tiers, expires_in_days: 7 },
    },
    {
      name: 'excessive tier total',
      method: 'PUT',
      path: '/policy',
      payload: {
        ...POLICY_UPDATE,
        tiers: [{ threshold_yuan: 100, total_slots: 1001 }],
      },
    },
    {
      name: 'empty tier ladder',
      method: 'PUT',
      path: '/policy',
      payload: { ...POLICY_UPDATE, tiers: [] },
    },
    {
      name: 'duplicate thresholds',
      method: 'PUT',
      path: '/policy',
      payload: {
        ...POLICY_UPDATE,
        tiers: [
          { threshold_yuan: 30, total_slots: 3 },
          { threshold_yuan: 30, total_slots: 5 },
        ],
      },
    },
    {
      name: 'decreasing slot totals',
      method: 'PUT',
      path: '/policy',
      payload: {
        ...POLICY_UPDATE,
        tiers: [
          { threshold_yuan: 30, total_slots: 5 },
          { threshold_yuan: 100, total_slots: 3 },
        ],
      },
    },
    {
      name: 'obsolete single-threshold input',
      method: 'PUT',
      path: '/policy',
      payload: {
        threshold_yuan: 100,
        default_slots: 3,
        expires_in_days: 7,
        expected_revision: 1,
      },
    },
    {
      name: 'excessive code lifetime',
      method: 'PUT',
      path: '/policy',
      payload: { ...POLICY_UPDATE, expires_in_days: 91 },
    },
    {
      name: 'negative allowance',
      method: 'PATCH',
      path: `/users/${USER_ID}`,
      payload: { total_slots: -1, suspended: false, expected_revision: 1 },
    },
    {
      name: 'missing account revision',
      method: 'PATCH',
      path: `/users/${USER_ID}`,
      payload: { total_slots: 3, suspended: false },
    },
    {
      name: 'fractional cent refund',
      method: 'POST',
      path: '/refunds',
      payload: { ...REFUND, amount_yuan: 20.001 },
    },
    {
      name: 'blank refund reason',
      method: 'POST',
      path: '/refunds',
      payload: { ...REFUND, reason: '  ' },
    },
  ] as const)(
    'rejects $name before invoking repository mutations',
    async ({ method, path, payload }) => {
      const response = await app.inject({
        method,
        url: `/api/admin/registration-invites${path}`,
        headers: OWNER_HEADERS,
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      for (const operation of Object.values(repository))
        expect(operation).not.toHaveBeenCalled();
    },
  );
});
