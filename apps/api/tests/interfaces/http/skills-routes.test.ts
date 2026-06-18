import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCheckSkillCommentSubmissionGuard,
  mockCreatePendingSkillComment,
  mockCreateSkillAccessInvite,
  mockGetSkillAccessInvitePreviewByToken,
  mockGetSkillReactionSummary,
  mockGetUserSkillReaction,
  mockHasActiveMembership,
  mockListPublicSkillComments,
  mockListSkillAccessInvites,
  mockListUserPendingSkillComments,
  mockRedeemSkillAccessInvite,
  mockSetUserSkillReaction,
  serviceMocks,
} = vi.hoisted(() => {
  const mockCheckSkillCommentSubmissionGuard = vi.fn();
  const mockCreatePendingSkillComment = vi.fn();
  const mockCreateSkillAccessInvite = vi.fn();
  const mockGetSkillAccessInvitePreviewByToken = vi.fn();
  const mockGetSkillReactionSummary = vi.fn();
  const mockGetUserSkillReaction = vi.fn();
  const mockHasActiveMembership = vi.fn();
  const mockListPublicSkillComments = vi.fn();
  const mockListSkillAccessInvites = vi.fn();
  const mockListUserPendingSkillComments = vi.fn();
  const mockRedeemSkillAccessInvite = vi.fn();
  const mockRevokeSkillAccessInvite = vi.fn();
  const mockSetUserSkillReaction = vi.fn();
  const noop = vi.fn();
  return {
    mockCheckSkillCommentSubmissionGuard,
    mockCreatePendingSkillComment,
    mockCreateSkillAccessInvite,
    mockGetSkillAccessInvitePreviewByToken,
    mockGetSkillReactionSummary,
    mockGetUserSkillReaction,
    mockHasActiveMembership,
    mockListPublicSkillComments,
    mockListSkillAccessInvites,
    mockListUserPendingSkillComments,
    mockRedeemSkillAccessInvite,
    mockSetUserSkillReaction,
    serviceMocks: {
      checkSkillCommentSubmissionGuard: mockCheckSkillCommentSubmissionGuard,
      createPendingSkillComment: mockCreatePendingSkillComment,
      createSkillAccessInvite: mockCreateSkillAccessInvite,
      getSkillAccessInvitePreviewByToken:
        mockGetSkillAccessInvitePreviewByToken,
      getSkillReactionSummary: mockGetSkillReactionSummary,
      getUserSkillReaction: mockGetUserSkillReaction,
      hasActiveMembership: mockHasActiveMembership,
      listPublicSkillComments: mockListPublicSkillComments,
      listSkillAccessInvites: mockListSkillAccessInvites,
      listUserPendingSkillComments: mockListUserPendingSkillComments,
      redeemSkillAccessInvite: mockRedeemSkillAccessInvite,
      revokeSkillAccessInvite: mockRevokeSkillAccessInvite,
      setUserSkillReaction: mockSetUserSkillReaction,
      createSkillBundle: noop,
      createUserCustomSkill: noop,
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

vi.mock('../../../src/modules/skills/skills-service.js', () => ({
  ...serviceMocks,
  MAX_SKILL_BUNDLE_FILE_LENGTH: 100000,
  MAX_SKILL_BUNDLE_FILES: 50,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH: 500000,
  MAX_USER_SKILLS: 30,
}));

import { skillsRoutes } from '../../../src/interfaces/http/skills-routes.js';

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
    mockGetSkillReactionSummary.mockResolvedValue({
      like_count: 0,
      dislike_count: 0,
    });
    mockGetUserSkillReaction.mockResolvedValue(null);
    mockHasActiveMembership.mockResolvedValue(false);
    mockCheckSkillCommentSubmissionGuard.mockResolvedValue({
      allowed: true,
      reason: null,
    });
    mockListPublicSkillComments.mockResolvedValue([]);
    mockListSkillAccessInvites.mockResolvedValue([]);
    mockListUserPendingSkillComments.mockResolvedValue([]);
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

  it('returns shared skill details with approved comments and viewer pending comments only', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockGetSkillReactionSummary.mockResolvedValue({
      like_count: 3,
      dislike_count: 1,
    });
    mockGetUserSkillReaction.mockResolvedValue('like');
    mockListPublicSkillComments.mockResolvedValue([
      {
        id: 'comment-1',
        body: '已审核评论',
        pinned: true,
        created_at: '2026-01-02T00:00:00.000Z',
        user_id: 'hidden-user',
      },
    ]);
    mockListUserPendingSkillComments.mockResolvedValue([
      {
        id: 'comment-2',
        body: '我的待审核评论',
        status: 'pending',
        created_at: '2026-01-03T00:00:00.000Z',
        user_id: 'viewer-1',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/shared/share-token',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        id: 'skill-1',
        public_interactions_enabled: true,
        comments_enabled: true,
        reaction_summary: { like_count: 3, dislike_count: 1 },
        my_reaction: 'like',
        comments: [
          {
            id: 'comment-1',
            body: '已审核评论',
            pinned: true,
            created_at: '2026-01-02T00:00:00.000Z',
          },
        ],
        my_pending_comments: [
          {
            id: 'comment-2',
            body: '我的待审核评论',
            status: 'pending',
            created_at: '2026-01-03T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(response.json().comments[0]).not.toHaveProperty('user_id');
    expect(response.json().my_pending_comments[0]).not.toHaveProperty(
      'user_id',
    );
    expect(mockGetUserSkillReaction).toHaveBeenCalledWith(
      'skill-1',
      'viewer-1',
    );
    expect(mockListUserPendingSkillComments).toHaveBeenCalledWith(
      'skill-1',
      'viewer-1',
    );
  });

  it('returns public shared skill details for anonymous visitors with null reaction', async () => {
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockGetSkillReactionSummary.mockResolvedValue({
      like_count: 3,
      dislike_count: 1,
    });
    mockListPublicSkillComments.mockResolvedValue([]);

    // 不带 authorization 头：getOptionalUserId 应安全降级为游客而非报错
    const response = await app.inject({
      method: 'GET',
      url: '/shared/share-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      public_interactions_enabled: true,
      comments_enabled: true,
      reaction_summary: { like_count: 3, dislike_count: 1 },
      my_reaction: null,
      my_pending_comments: [],
    });
    // 游客无身份，反应查询应以 null userId 调用
    expect(mockGetUserSkillReaction).toHaveBeenCalledWith('skill-1', null);
    expect(mockListUserPendingSkillComments).toHaveBeenCalledWith(
      'skill-1',
      null,
    );
  });

  it('treats invalid optional auth on shared skill details as anonymous', async () => {
    const staleToken = app.jwt.sign({ userId: 'viewer-1' });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockGetSkillReactionSummary.mockResolvedValue({
      like_count: 3,
      dislike_count: 1,
    });
    mockListPublicSkillComments.mockResolvedValue([]);

    const response = await app.inject({
      method: 'GET',
      url: '/shared/share-token',
      headers: { authorization: `Bearer ${staleToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      public_interactions_enabled: true,
      my_reaction: null,
    });
    expect(mockGetUserSkillReaction).toHaveBeenCalledWith('skill-1', null);
  });

  it('hides interactions for private share skill details', async () => {
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'link_shared',
      share_token: 'private-token',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/shared/private-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      public_interactions_enabled: false,
      comments_enabled: false,
      reaction_summary: { like_count: 0, dislike_count: 0 },
      my_reaction: null,
      comments: [],
      my_pending_comments: [],
    });
    expect(mockGetSkillReactionSummary).not.toHaveBeenCalled();
    expect(mockListPublicSkillComments).not.toHaveBeenCalled();
    expect(mockListUserPendingSkillComments).not.toHaveBeenCalled();
  });

  it('requires login before reacting to public shared skills', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/shared/share-token/reaction',
      payload: { kind: 'like' },
    });

    expect(response.statusCode).toBe(401);
    expect(mockSetUserSkillReaction).not.toHaveBeenCalled();
  });

  it('sets public shared skill reactions for authenticated users', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockSetUserSkillReaction.mockResolvedValue('dislike');
    mockGetSkillReactionSummary.mockResolvedValue({
      like_count: 2,
      dislike_count: 4,
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/shared/share-token/reaction',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'dislike' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockSetUserSkillReaction).toHaveBeenCalledWith(
      'skill-1',
      'viewer-1',
      'dislike',
    );
    expect(response.json()).toEqual({
      reaction_summary: { like_count: 2, dislike_count: 4 },
      my_reaction: 'dislike',
    });
  });

  it('clears public shared skill reactions when kind is null', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockSetUserSkillReaction.mockResolvedValue(null);
    mockGetSkillReactionSummary.mockResolvedValue({
      like_count: 5,
      dislike_count: 2,
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/shared/share-token/reaction',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: null },
    });

    expect(response.statusCode).toBe(200);
    expect(mockSetUserSkillReaction).toHaveBeenCalledWith(
      'skill-1',
      'viewer-1',
      null,
    );
    // 清除后应回传最新计数与空反应，供前端同步按钮状态
    expect(response.json()).toEqual({
      reaction_summary: { like_count: 5, dislike_count: 2 },
      my_reaction: null,
    });
  });

  it('does not allow reactions on private share links', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'link_shared',
      share_token: 'private-token',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/shared/private-token/reaction',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'like' },
    });

    expect(response.statusCode).toBe(404);
    expect(mockSetUserSkillReaction).not.toHaveBeenCalled();
  });

  it('rejects comments from non-members', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockHasActiveMembership.mockResolvedValue(false);

    const response = await app.inject({
      method: 'POST',
      url: '/shared/share-token/comments',
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '评论内容' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: '仅会员可发表评论' });
    expect(mockCreatePendingSkillComment).not.toHaveBeenCalled();
  });

  it('creates pending comments for active members', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockHasActiveMembership.mockResolvedValue(true);
    mockCreatePendingSkillComment.mockResolvedValue({
      id: 'comment-1',
      status: 'pending',
      body: '第一行 第二行',
      created_at: '2026-01-04T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/shared/share-token/comments',
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '  第一行\n第二行  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockCreatePendingSkillComment).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'skill-1',
        userId: 'viewer-1',
        body: '第一行 第二行',
      }),
    );
    expect(response.json()).toEqual({
      id: 'comment-1',
      status: 'pending',
      body: '第一行 第二行',
      created_at: '2026-01-04T00:00:00.000Z',
    });
  });

  it('blocks duplicate pending comments before creating a row', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockHasActiveMembership.mockResolvedValue(true);
    mockCheckSkillCommentSubmissionGuard.mockResolvedValue({
      allowed: false,
      reason: 'duplicate_pending',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/shared/share-token/comments',
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '重复评论' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: '相同评论正在审核中，请勿重复提交',
    });
    expect(mockCheckSkillCommentSubmissionGuard).toHaveBeenCalledWith({
      skillId: 'skill-1',
      userId: 'viewer-1',
      body: '重复评论',
    });
    expect(mockCreatePendingSkillComment).not.toHaveBeenCalled();
  });

  it('rejects empty comment body from members', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockHasActiveMembership.mockResolvedValue(true);

    const response = await app.inject({
      method: 'POST',
      url: '/shared/share-token/comments',
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: '评论内容不能为空' });
    expect(mockCreatePendingSkillComment).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only comment body after collapsing', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockHasActiveMembership.mockResolvedValue(true);

    const response = await app.inject({
      method: 'POST',
      url: '/shared/share-token/comments',
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '   \n\t  ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: '评论内容不能为空' });
    expect(mockCreatePendingSkillComment).not.toHaveBeenCalled();
  });

  it('rejects comment body longer than 500 chars', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'shared',
      share_token: 'share-token',
    });
    mockHasActiveMembership.mockResolvedValue(true);

    const response = await app.inject({
      method: 'POST',
      url: '/shared/share-token/comments',
      headers: { authorization: `Bearer ${token}` },
      // 折叠空白后仍为 501 个连续字符，触发长度上限
      payload: { body: 'a'.repeat(501) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: '评论内容不超过 500 字' });
    expect(mockCreatePendingSkillComment).not.toHaveBeenCalled();
  });

  it('does not allow comments on private share links', async () => {
    const token = app.jwt.sign({ userId: 'viewer-1', authTokenVersion: 1 });
    serviceMocks.getSkillByShareToken.mockResolvedValue({
      ...skillPreview,
      visibility: 'link_shared',
      share_token: 'private-token',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/shared/private-token/comments',
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '评论内容' },
    });

    expect(response.statusCode).toBe(404);
    expect(mockCreatePendingSkillComment).not.toHaveBeenCalled();
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
