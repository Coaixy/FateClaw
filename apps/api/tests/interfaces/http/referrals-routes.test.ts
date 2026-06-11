import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetMyReferralSummary,
  mockPreviewInviteCode,
  mockRedeemInviteCodeForUser,
} = vi.hoisted(() => ({
  mockGetMyReferralSummary: vi.fn(),
  mockPreviewInviteCode: vi.fn(),
  mockRedeemInviteCodeForUser: vi.fn(),
}));

vi.mock('../../../src/modules/referrals/referrals-service.js', () => ({
  getMyReferralSummary: mockGetMyReferralSummary,
  previewInviteCode: mockPreviewInviteCode,
  redeemInviteCodeForUser: mockRedeemInviteCodeForUser,
}));

import { referralsRoutes } from '../../../src/interfaces/http/referrals-routes.js';

describe('referralsRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    await app.register(fastifyJwt, { secret: 'test-secret' });
    app.decorateRequest('requireAuth', async () => {});
    app.addHook('onRequest', async (request) => {
      request.requireAuth = async () => {
        await request.jwtVerify();
      };
    });
    await app.register(referralsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('previews invite codes without authentication', async () => {
    mockPreviewInviteCode.mockResolvedValue({
      ok: true,
      data: { code: 'ABC123', status: 'active' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/invites/ABC123/preview',
    });

    expect(response.statusCode).toBe(200);
    expect(mockPreviewInviteCode).toHaveBeenCalledWith('ABC123');
    expect(response.json()).toEqual({ code: 'ABC123', status: 'active' });
  });

  it('requires login before redeeming invite codes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/invites/ABC123/redeem',
    });

    expect(response.statusCode).toBe(401);
    expect(mockRedeemInviteCodeForUser).not.toHaveBeenCalled();
  });

  it('redeems invite codes for authenticated users', async () => {
    const token = app.jwt.sign({ userId: 'user-1' });
    mockRedeemInviteCodeForUser.mockResolvedValue({
      ok: true,
      data: {
        referral_id: 'ref-1',
        inviter_id: 'inviter-1',
        invitee_id: 'user-1',
        created: true,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/invites/ABC123/redeem',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(mockRedeemInviteCodeForUser).toHaveBeenCalledWith(
      'user-1',
      'ABC123',
    );
    expect(response.json()).toMatchObject({ referral_id: 'ref-1' });
  });

  it('loads current user referral summary', async () => {
    const token = app.jwt.sign({ userId: 'user-1' });
    mockGetMyReferralSummary.mockResolvedValue({
      ok: true,
      data: {
        invite_code: 'ABC123',
        invite_url: '/invite?code=ABC123',
        invited_count: 1,
        rewarded_count: 0,
        total_reward_days: 0,
        config: {
          enabled: true,
          inviter_reward_days: 7,
          monthly_reward_cap_days: 30,
          reward_first_membership_only: true,
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetMyReferralSummary).toHaveBeenCalledWith('user-1');
  });
});
