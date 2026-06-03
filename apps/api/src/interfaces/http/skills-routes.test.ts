import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateSkillAccessInvite,
  mockGetSkillAccessInvitePreviewByToken,
  mockListSkillAccessInvites,
  mockRedeemSkillAccessInvite,
  mockRevokeSkillAccessInvite,
  serviceMocks,
} = vi.hoisted(() => {
  const mockCreateSkillAccessInvite = vi.fn();
  const mockGetSkillAccessInvitePreviewByToken = vi.fn();
  const mockListSkillAccessInvites = vi.fn();
  const mockRedeemSkillAccessInvite = vi.fn();
  const mockRevokeSkillAccessInvite = vi.fn();
  const noop = vi.fn();
  return {
    mockCreateSkillAccessInvite,
    mockGetSkillAccessInvitePreviewByToken,
    mockListSkillAccessInvites,
    mockRedeemSkillAccessInvite,
    mockRevokeSkillAccessInvite,
    serviceMocks: {
      createSkillAccessInvite: mockCreateSkillAccessInvite,
      getSkillAccessInvitePreviewByToken:
        mockGetSkillAccessInvitePreviewByToken,
      listSkillAccessInvites: mockListSkillAccessInvites,
      redeemSkillAccessInvite: mockRedeemSkillAccessInvite,
      revokeSkillAccessInvite: mockRevokeSkillAccessInvite,
      createSkillBundle: noop,
      createUserCustomSkill: noop,
      deleteSkillBundle: noop,
      deleteUserCustomSkill: noop,
      getBundleByToken: noop,
      getSkillByShareToken: noop,
      getSubscribedSkills: noop,
      getUserCustomSkill: noop,
      getUserCustomSkillCount: noop,
      getUserCustomSkills: noop,
      listMarketBundles: noop,
      listMarketSkills: noop,
      listUserBundles: noop,
      publishSkillBundle: noop,
      publishUserCustomSkill: noop,
      shareSkillBundle: noop,
      shareUserCustomSkill: noop,
      slugifySkillName: (name: string) => `user-${name}`,
      subscribeToBundle: noop,
      subscribeToSkill: noop,
      toggleSubscription: noop,
      toggleUserCustomSkill: noop,
      unpublishSkillBundle: noop,
      unpublishUserCustomSkill: noop,
      unsubscribeFromBundle: noop,
      unsubscribeFromSkill: noop,
      unshareSkillBundle: noop,
      unshareUserCustomSkill: noop,
      updateSkillBundle: noop,
      updateUserCustomSkill: noop,
    },
  };
});

vi.mock('../../modules/skills/skills-service.js', () => ({
  ...serviceMocks,
  MAX_SKILL_BUNDLE_FILE_LENGTH: 100000,
  MAX_SKILL_BUNDLE_FILES: 50,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH: 500000,
  MAX_USER_SKILLS: 30,
}));

import { skillsRoutes } from './skills-routes.js';

const inviteRow = {
  id: 'invite-1',
  creator_id: 'creator-1',
  target_type: 'skill' as const,
  target_id: 'skill-1',
  token: 'invite-token',
  max_redemptions: 1,
  redeemed_count: 0,
  expires_at: null,
  revoked_at: null,
  note: '',
  created_at: '2026-01-01T00:00:00.000Z',
};

const skillPreview = {
  id: 'skill-1',
  user_id: 'creator-1',
  skill_name: 'Invite Skill',
  dir_name: 'invite-skill',
  description: 'desc',
  version: '1.0.0',
  bundle_uri: 'text-skill://skill-1',
  checksum: null,
  install_status: 'installed' as const,
  acl: {},
  billing_policy: {},
  audit_metadata: {},
  files: [],
  content_length: 12,
  visibility: 'private' as const,
  share_token: null,
  enabled: true,
  stat_subscriber_count: 0,
  stat_view_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
};

describe('skillsRoutes access invites', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockListSkillAccessInvites.mockResolvedValue([]);
    app = Fastify({ logger: false });
    await app.register(fastifyJwt, { secret: 'test-secret' });
    app.decorateRequest('requireAuth', async () => {});
    app.addHook('onRequest', async (request) => {
      request.requireAuth = async () => {
        await request.jwtVerify();
      };
    });
    await app.register(skillsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('previews access invite links without authentication', async () => {
    mockGetSkillAccessInvitePreviewByToken.mockResolvedValue({
      invite: inviteRow,
      status: 'active',
      skill: skillPreview,
      bundle: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/access-invites/invite-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'invite-token',
      target_type: 'skill',
      status: 'active',
      skill: { id: 'skill-1', skill_name: 'Invite Skill' },
      bundle: null,
    });
  });

  it('requires login before redeeming access invites', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/access-invites/invite-token/redeem',
    });

    expect(response.statusCode).toBe(401);
    expect(mockRedeemSkillAccessInvite).not.toHaveBeenCalled();
  });

  it('redeems skill access invites for authenticated users', async () => {
    const token = app.jwt.sign({ userId: 'user-1' });
    mockRedeemSkillAccessInvite.mockResolvedValue({
      status: 'redeemed',
      targetType: 'skill',
      subscribedCount: 1,
      skippedCount: 0,
      subscriptionIds: ['sub-1'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/access-invites/invite-token/redeem',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(mockRedeemSkillAccessInvite).toHaveBeenCalledWith(
      'user-1',
      'invite-token',
    );
    expect(response.json()).toEqual({
      target_type: 'skill',
      subscribed_count: 1,
      skipped_count: 0,
      subscription_ids: ['sub-1'],
    });
  });

  it('reports revoked access invites during redeem', async () => {
    const token = app.jwt.sign({ userId: 'user-1' });
    mockRedeemSkillAccessInvite.mockResolvedValue({
      status: 'revoked',
      targetType: 'skill',
      subscribedCount: 0,
      skippedCount: 0,
      subscriptionIds: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/access-invites/invite-token/redeem',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: '授权链接已撤销' });
  });

  it('creates owner access invites without payment fields', async () => {
    const token = app.jwt.sign({ userId: 'creator-1' });
    mockCreateSkillAccessInvite.mockResolvedValue(inviteRow);

    const response = await app.inject({
      method: 'POST',
      url: '/access-invites',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        target_type: 'skill',
        target_id: 'skill-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockCreateSkillAccessInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorId: 'creator-1',
        targetType: 'skill',
        targetId: 'skill-1',
        maxRedemptions: 1,
        expiresAt: null,
        note: '',
      }),
    );
    expect(response.json()).toMatchObject({
      install_url: '/skills/install?invite=invite-token',
      status: 'active',
    });
  });
});
