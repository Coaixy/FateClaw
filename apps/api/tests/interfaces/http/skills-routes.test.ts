import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateSkillAccessInvite,
  mockGetSkillAccessInvitePreviewByToken,
  mockListSkillAccessInvites,
  mockRedeemSkillAccessInvite,
  serviceMocks,
} = vi.hoisted(() => {
  const mockCreateSkillAccessInvite = vi.fn();
  const mockGetSkillAccessInvitePreviewByToken = vi.fn();
  const mockListSkillAccessInvites = vi.fn();
  const mockRedeemSkillAccessInvite = vi.fn();
  const mockRevokeSkillAccessInvite = vi.fn();
  const mockCreateUserCustomSkill = vi.fn();
  const noop = vi.fn();
  return {
    mockCreateSkillAccessInvite,
    mockGetSkillAccessInvitePreviewByToken,
    mockListSkillAccessInvites,
    mockRedeemSkillAccessInvite,
    serviceMocks: {
      SkillRevisionConflictError: class extends Error {},
      createSkillAccessInvite: mockCreateSkillAccessInvite,
      getSkillAccessInvitePreviewByToken:
        mockGetSkillAccessInvitePreviewByToken,
      listSkillAccessInvites: mockListSkillAccessInvites,
      redeemSkillAccessInvite: mockRedeemSkillAccessInvite,
      revokeSkillAccessInvite: mockRevokeSkillAccessInvite,
      createSkillBundle: noop,
      createUserCustomSkill: mockCreateUserCustomSkill,
      deleteSkillBundle: noop,
      deleteUserCustomSkill: noop,
      getBundleByToken: noop,
      getSkillBundleLimitsPolicy: vi.fn(async () => ({
        max_files: 50,
        max_file_chars: 100000,
        max_total_chars: 500000,
        max_zip_bytes: 8 * 1024 * 1024,
      })),
      getSkillByShareToken: noop,
      getSubscribedSkills: noop,
      getUserCustomSkill: noop,
      getUserCustomSkillCount: noop,
      getUserCustomSkills: noop,
      getUserSkillLimitPolicy: vi.fn(async () => 30),
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
      updateUserCustomSkill: vi.fn(),
    },
  };
});

vi.mock('#modules/skills/skills-service', () => ({
  ...serviceMocks,
}));

import { skillsRoutes } from '#interfaces/http/skills-routes';

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
        if (request.user.authTokenVersion !== 1) {
          const err = new Error('未登录或 token 已过期') as Error & {
            statusCode: number;
          };
          err.statusCode = 401;
          throw err;
        }
      };
    });
    await app.register(skillsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns skill summaries without file contents and requests no full-content projections', async () => {
    serviceMocks.getUserCustomSkills.mockResolvedValueOnce([
      {
        ...skillPreview,
        files: [{ path: 'SKILL.md', content: 'private body' }],
      },
    ]);
    serviceMocks.getSubscribedSkills.mockResolvedValueOnce([]);
    const token = app.jwt.sign({ userId: 'creator-1', authTokenVersion: 1 });
    const response = await app.inject({
      method: 'GET',
      url: '/user',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().own[0]).not.toHaveProperty('files');
    expect(serviceMocks.getUserCustomSkills).toHaveBeenCalledWith(
      'creator-1',
      false,
    );
    expect(serviceMocks.getSubscribedSkills).toHaveBeenCalledWith(
      'creator-1',
      false,
    );
  });

  it('requires the editor base revision and returns a distinct conflict without accepting a stale save', async () => {
    const token = app.jwt.sign({ userId: 'creator-1', authTokenVersion: 1 });
    const headers = { authorization: `Bearer ${token}` };
    const missing = await app.inject({
      method: 'PUT',
      url: '/user/skill-1',
      headers,
      payload: { files: [{ path: 'SKILL.md', content: '# Draft' }] },
    });
    expect(missing.statusCode).toBe(428);
    expect(serviceMocks.updateUserCustomSkill).not.toHaveBeenCalled();
    serviceMocks.updateUserCustomSkill.mockRejectedValueOnce(
      new serviceMocks.SkillRevisionConflictError('保留草稿并重新加载'),
    );
    const conflict = await app.inject({
      method: 'PUT',
      url: '/user/skill-1',
      headers,
      payload: {
        base_revision_id: 'old-revision',
        files: [{ path: 'SKILL.md', content: '# Draft' }],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'skill_revision_conflict' });
    expect(serviceMocks.updateUserCustomSkill).toHaveBeenCalledWith(
      'skill-1',
      'creator-1',
      {
        base_revision_id: 'old-revision',
        files: [{ path: 'SKILL.md', content: '# Draft' }],
      },
    );
  });

  it('returns current Skill Bundle limits', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/limits',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      max_files: 50,
      max_file_chars: 100000,
      max_total_chars: 500000,
      max_zip_bytes: 8 * 1024 * 1024,
    });
  });

  describe.each([
    { method: 'POST', url: '/user' },
    { method: 'PUT', url: '/user/skill-1' },
  ] as const)('$method $url content uploads', ({ method, url }) => {
    it('accepts a Chinese bundle at the configured character limit above 1 MiB', async () => {
      const files = Array.from({ length: 5 }, (_, index) => ({
        path: index === 0 ? 'SKILL.md' : `references/${index}.md`,
        content: '中'.repeat(100_000),
      }));
      const payload = {
        skill_name: 'Upload test',
        ...(method === 'PUT' ? { base_revision_id: 'revision-1' } : {}),
        files,
      };
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
        1024 * 1024,
      );
      const writer =
        method === 'POST'
          ? serviceMocks.createUserCustomSkill
          : serviceMocks.updateUserCustomSkill;
      writer.mockResolvedValueOnce(skillPreview);
      if (method === 'POST') {
        serviceMocks.getUserCustomSkillCount.mockResolvedValueOnce(0);
      }
      const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });

      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it('supports runtime limit increases and JSON escaping without restarting the server', async () => {
      serviceMocks.getSkillBundleLimitsPolicy.mockResolvedValueOnce({
        max_files: 50,
        max_file_chars: 2_000_000,
        max_total_chars: 10_000_000,
        max_zip_bytes: 8 * 1024 * 1024,
      });
      const writer =
        method === 'POST'
          ? serviceMocks.createUserCustomSkill
          : serviceMocks.updateUserCustomSkill;
      writer.mockResolvedValueOnce(skillPreview);
      if (method === 'POST') {
        serviceMocks.getUserCustomSkillCount.mockResolvedValueOnce(0);
      }
      const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });

      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          skill_name: 'Escaped upload',
          ...(method === 'PUT' ? { base_revision_id: 'revision-1' } : {}),
          files: Array.from({ length: 5 }, (_, index) => ({
            path: index === 0 ? 'SKILL.md' : `references/${index}.txt`,
            content: '\u0001'.repeat(2_000_000),
          })),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        files: [{ path: 'SKILL.md', content: '中'.repeat(500_000) }],
        error: '单个文件内容不超过 100000 字',
      },
      {
        files: Array.from({ length: 6 }, (_, index) => ({
          path: index === 0 ? 'SKILL.md' : `references/${index}.md`,
          content: '中'.repeat(index === 5 ? 1 : 100_000),
        })),
        error: 'Bundle 总内容不超过 500000 字',
      },
    ])(
      'still rejects content exceeding policy: $error',
      async ({ files, error }) => {
        const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });
        const response = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            skill_name: 'Oversized upload',
            ...(method === 'PUT' ? { base_revision_id: 'revision-1' } : {}),
            files,
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error });
        expect(serviceMocks.createUserCustomSkill).not.toHaveBeenCalled();
        expect(serviceMocks.updateUserCustomSkill).not.toHaveBeenCalled();
      },
    );

    it('keeps a finite request byte limit before calling the writer', async () => {
      const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });
      const response = await app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(65 * 1024 * 1024),
        },
        payload: '{}',
      });

      expect(response.statusCode).toBe(413);
      expect(serviceMocks.createUserCustomSkill).not.toHaveBeenCalled();
      expect(serviceMocks.updateUserCustomSkill).not.toHaveBeenCalled();
    });

    it('authenticates before reading an oversized upload body', async () => {
      const response = await app.inject({
        method,
        url,
        headers: {
          'content-type': 'application/json',
          'content-length': String(65 * 1024 * 1024),
        },
        payload: '{}',
      });

      expect(response.statusCode).toBe(401);
      expect(serviceMocks.getSkillBundleLimitsPolicy).not.toHaveBeenCalled();
      expect(serviceMocks.createUserCustomSkill).not.toHaveBeenCalled();
      expect(serviceMocks.updateUserCustomSkill).not.toHaveBeenCalled();
    });
  });

  it('returns a readable conflict when creating a duplicate own skill', async () => {
    const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });
    serviceMocks.getUserCustomSkillCount.mockResolvedValueOnce(0);
    serviceMocks.createUserCustomSkill.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'duplicate key value violates unique constraint "idx_ucs_user_dir_active"',
        ),
        {
          code: '23505',
          constraint: 'idx_ucs_user_dir_active',
        },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/user',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        skill_name: '我的 Skill',
        files: [
          {
            path: 'SKILL.md',
            content: '---\nname: 我的 Skill\ndescription: desc\n---\n',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: '当前账号已存在同名 Skill，请改名后再创建，或先删除旧 Skill',
    });
    expect(serviceMocks.createUserCustomSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        dir_name: 'user-我的 Skill',
      }),
    );
  });

  it('uses runtime config when checking user custom skill count limit', async () => {
    const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });
    const createCallCount =
      serviceMocks.createUserCustomSkill.mock.calls.length;
    serviceMocks.getUserSkillLimitPolicy.mockResolvedValueOnce(2);
    serviceMocks.getUserCustomSkillCount.mockResolvedValueOnce(2);

    const response = await app.inject({
      method: 'POST',
      url: '/user',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        skill_name: '第三个 Skill',
        files: [
          {
            path: 'SKILL.md',
            content: '---\nname: 第三个 Skill\ndescription: desc\n---\n',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: '自定义技能数量已达上限（2）',
    });
    expect(serviceMocks.createUserCustomSkill).toHaveBeenCalledTimes(
      createCallCount,
    );
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
    const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });
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
    const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 1 });
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

  it('returns shared skill install preview without public interaction fields', async () => {
    // 公开 toC 互动已下线：/shared/:token 现仅返回安装预览级字段。
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/shared/share-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'skill-1',
      skill_name: 'Invite Skill',
      description: 'desc',
      content_length: 12,
      author_label: '匿名作者',
    });
    expect(response.json()).not.toHaveProperty('reaction_summary');
    expect(response.json()).not.toHaveProperty('comments');
  });

  it('returns 404 for unknown shared skill tokens', async () => {
    serviceMocks.getSkillByShareToken.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/shared/missing-token',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '分享链接无效' });
  });

  it('creates owner access invites without payment fields', async () => {
    const token = app.jwt.sign({ userId: 'creator-1', authTokenVersion: 1 });
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

  it('clamps public skill market limit before calling the service', async () => {
    serviceMocks.listMarketSkills.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/market?limit=999&offset=10',
    });

    expect(response.statusCode).toBe(200);
    expect(serviceMocks.listMarketSkills).toHaveBeenCalledWith({
      limit: 100,
      offset: 10,
    });
  });

  it('rejects invalid public skill market offsets', async () => {
    const negativeResponse = await app.inject({
      method: 'GET',
      url: '/market?offset=-1',
    });
    const oversizedResponse = await app.inject({
      method: 'GET',
      url: '/market?offset=10001',
    });

    expect(negativeResponse.statusCode).toBe(400);
    expect(oversizedResponse.statusCode).toBe(400);
    expect(serviceMocks.listMarketSkills).not.toHaveBeenCalled();
  });

  it('clamps public bundle market limit before calling the service', async () => {
    serviceMocks.listMarketBundles.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/bundles/market?limit=999&offset=12',
    });

    expect(response.statusCode).toBe(200);
    expect(serviceMocks.listMarketBundles).toHaveBeenCalledWith({
      limit: 50,
      offset: 12,
    });
  });

  it('rejects invalid public bundle market offsets', async () => {
    const negativeResponse = await app.inject({
      method: 'GET',
      url: '/bundles/market?offset=-1',
    });
    const oversizedResponse = await app.inject({
      method: 'GET',
      url: '/bundles/market?offset=10001',
    });

    expect(negativeResponse.statusCode).toBe(400);
    expect(oversizedResponse.statusCode).toBe(400);
    expect(serviceMocks.listMarketBundles).not.toHaveBeenCalled();
  });
});
