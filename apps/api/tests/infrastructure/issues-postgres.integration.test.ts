import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Redis from 'ioredis';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const state = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  redis: null as Redis | null,
}));
vi.mock('../../src/infrastructure/db-pool.js', () => ({
  getDbPool: () => state.pool,
}));
vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: () => state.redis,
}));
import { issuesMigration } from '../../src/infrastructure/migrations/versions/0086-issues.js';
import {
  issuesRoutes,
  adminIssueRoutes,
} from '../../src/interfaces/http/issues-routes.js';
import { fixedWindowRateLimit } from '../../src/interfaces/http/rate-limit.js';

// Both endpoints must identify disposable stores; application configuration is never read.
const databaseUrl = process.env.FATECLAW_TEST_ISSUES_DATABASE_URL;
const redisUrl = process.env.FATECLAW_TEST_ISSUES_REDIS_URL;
describe.skipIf(!databaseUrl || !redisUrl)(
  'anonymous issues with PostgreSQL and Redis',
  () => {
    let root: pg.Pool;
    let database: string;
    let app: FastifyInstance;
    const auth = (user = 'alice') => ({ authorization: `Bearer ${user}` });
    const admin = { 'x-test-admin': 'owner' };
    const issue = (title = 'Synthetic issue') => ({
      title,
      body: 'Synthetic description',
      kind: 'bug',
      request_key: randomUUID(),
    });
    const create = async (user = 'alice', payload = issue()) =>
      app.inject({
        method: 'POST',
        url: '/api/issues',
        headers: auth(user),
        payload,
      });
    const comment = (
      id: number,
      user = 'bob',
      body = 'Synthetic reply',
      request_key = randomUUID(),
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/issues/${id}/comments`,
        headers: auth(user),
        payload: { body, request_key },
      });
    const moderate = (id: number, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/api/admin/issues/${id}`,
        headers: admin,
        payload,
      });
    const resetRate = () => state.redis!.flushdb();

    beforeAll(async () => {
      root = new pg.Pool({ connectionString: databaseUrl });
      database = `fateclaw_issues_${randomUUID().replaceAll('-', '')}`;
      await root.query(`CREATE DATABASE "${database}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      state.pool = new pg.Pool({ connectionString: url.toString(), max: 12 });
      state.redis = new Redis(redisUrl!, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 1000,
      });
      if (state.redis.status !== 'ready')
        await new Promise<void>((resolve, reject) => {
          state.redis!.once('ready', resolve);
          state.redis!.once('error', reject);
        });
      await state.pool.query(
        'CREATE TABLE users(id text PRIMARY KEY,phone text,phone_verified boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now())',
      );
      const client = await state.pool.connect();
      try {
        await issuesMigration.up(client);
      } finally {
        client.release();
      }
      app = Fastify({ trustProxy: 'loopback' });
      app.decorateRequest('requireAuth', async () => {});
      app.addHook('onRequest', async (request) => {
        request.requireAuth = async () => {
          const user = request.headers.authorization?.replace('Bearer ', '');
          if (!['alice', 'bob', 'carol'].includes(user ?? ''))
            throw Object.assign(new Error('Synthetic unauthorized'), {
              statusCode: 401,
            });
          request.user = { userId: user!, authTokenVersion: 0 };
        };
      });
      await app.register(issuesRoutes, { prefix: '/api/issues' });
      await app.register(
        async (scope) => {
          scope.addHook('onRequest', async (request) => {
            if (request.headers['x-test-admin'] === 'owner')
              request.adminPrincipal = {
                role: 'owner',
                scopes: ['admin:*'],
                home_path: '/admin/overview',
              };
            else if (request.headers['x-test-admin'] === 'user_manager')
              request.adminPrincipal = {
                role: 'user_manager',
                scopes: ['users:read'],
                home_path: '/admin/users',
              };
          });
          await scope.register(adminIssueRoutes, { prefix: '/issues' });
        },
        { prefix: '/api/admin' },
      );
      await app.ready();
    }, 30_000);

    beforeEach(async () => {
      await resetRate();
      await state.pool!.query(
        'TRUNCATE issues,issue_user_moderation,users RESTART IDENTITY CASCADE',
      );
      await state.pool!.query(
        "INSERT INTO users(id,phone) VALUES('alice','13000000001'),('bob','13000000002'),('carol',NULL)",
      );
    });
    afterAll(async () => {
      await app?.close();
      state.redis?.disconnect();
      await state.pool?.end();
      if (database) await root.query(`DROP DATABASE "${database}"`);
      await root?.end();
    });

    it('keeps private attribution out of public responses and exposes it only to the owner admin', async () => {
      const id = (await create()).json().id;
      expect((await comment(id)).statusCode).toBe(201);
      const response = await app.inject({
        url: `/api/issues/${id}`,
        headers: auth('bob'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().issue.author).toEqual({
        kind: 'user',
        participant_number: 0,
        is_self: false,
      });
      expect(response.json().entries[0].author).toEqual({
        kind: 'user',
        participant_number: 1,
        is_self: true,
      });
      for (const url of ['/api/issues', `/api/issues/${id}`]) {
        expect((await app.inject({ method: 'HEAD', url })).statusCode).toBe(
          200,
        );
        const body = (await app.inject({ url })).body;
        for (const privateField of [
          'alice',
          'bob',
          '13000000001',
          '13000000002',
          'user_id',
          'request_hash',
          'request_key',
          'phone',
        ])
          expect(body).not.toContain(privateField);
      }
      const staff = await app.inject({
        url: `/api/admin/issues/${id}`,
        headers: admin,
      });
      expect(staff.json().identities).toMatchObject([
        { participant_number: 0, user_id: 'alice', phone: '13000000001' },
        { participant_number: 1, user_id: 'bob', phone: '13000000002' },
      ]);
      for (const headers of [{}, { 'x-test-admin': 'user_manager' }, auth()])
        expect(
          (await app.inject({ url: `/api/admin/issues/${id}`, headers }))
            .statusCode,
        ).toBe(403);
    });

    it('rejects unauthenticated writes, protected fields, oversized requests and malformed filters', async () => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/issues',
            payload: issue(),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await create('alice', {
            ...issue(),
            author_user_id: 'bob',
          } as ReturnType<typeof issue>)
        ).statusCode,
      ).toBe(400);
      expect(
        (await create('alice', { ...issue(), body: 'x'.repeat(70000) }))
          .statusCode,
      ).toBe(413);
      expect(
        (await app.inject({ url: '/api/issues?page_size=1000' })).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: '/api/issues?mine=true' })).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ url: '/api/issues', headers: auth('invalid') }))
          .statusCode,
      ).toBe(401);
      const id = (await create()).json().id;
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/issues/${id}`,
            headers: auth('bob'),
            payload: { title: 'Changed', body: 'Changed' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/issues/${id}`,
            headers: auth(),
            payload: { title: 'Changed', body: 'Changed', hidden: false },
          })
        ).statusCode,
      ).toBe(400);
    });

    it('serializes account quotas and keeps hidden content in the rolling daily budget', async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          create('alice', issue(`Concurrent ${index}`)),
        ),
      );
      expect(
        responses.filter((response) => response.statusCode === 201),
      ).toHaveLength(1);
      expect(
        responses.filter((response) => response.statusCode === 429),
      ).toHaveLength(7);
      const id = responses
        .find((response) => response.statusCode === 201)!
        .json().id;
      const clock = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + 3600_000);
      try {
        expect(
          (await create('alice', issue('Skewed API clock'))).statusCode,
        ).toBe(429);
      } finally {
        clock.mockRestore();
      }
      await resetRate();
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          comment(id, 'bob', `Concurrent reply ${index}`),
        ),
      );
      expect(
        replies.filter((response) => response.statusCode === 201),
      ).toHaveLength(1);
      expect(
        replies.filter((response) => response.statusCode === 429),
      ).toHaveLength(7);
      await state.pool!.query(
        "UPDATE issues SET created_at=clock_timestamp()-interval '61 seconds'",
      );
      for (let index = 1; index < 5; index++) {
        await resetRate();
        expect(
          (await create('alice', issue(`Daily ${index}`))).statusCode,
        ).toBe(201);
        await state.pool!.query(
          "UPDATE issues SET created_at=clock_timestamp()-interval '61 seconds',hidden=true",
        );
      }
      await resetRate();
      expect((await create('alice', issue('Sixth'))).statusCode).toBe(429);
      await state.pool!.query(
        "INSERT INTO issue_entries(issue_id,actor_kind,actor_user_id,type,body,request_key,request_hash,created_at,hidden) SELECT $1,'user','bob','comment','synthetic',gen_random_uuid(),'synthetic',clock_timestamp()-interval '11 seconds',true FROM generate_series(1,49)",
        [id],
      );
      await state.pool!.query('UPDATE issues SET hidden=false WHERE id=$1', [
        id,
      ]);
      await state.pool!.query(
        "UPDATE issue_entries SET created_at=clock_timestamp()-interval '11 seconds'",
      );
      expect((await comment(id, 'bob', 'Daily 51')).statusCode).toBe(429);
    });

    it('makes concurrent retries idempotent and refuses conflicting request keys', async () => {
      const payload = issue();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => create('alice', payload)),
      );
      expect(responses.every((response) => response.statusCode === 201)).toBe(
        true,
      );
      expect(
        new Set(responses.map((response) => response.json().id)).size,
      ).toBe(1);
      const id = responses[0].json().id;
      expect(
        (await create('alice', { ...payload, title: 'Conflicting' }))
          .statusCode,
      ).toBe(409);
      const key = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 8 }, () => comment(id, 'bob', 'Same reply', key)),
      );
      expect(replies.every((response) => response.statusCode === 201)).toBe(
        true,
      );
      expect(new Set(replies.map((response) => response.json().id)).size).toBe(
        1,
      );
      expect((await comment(id, 'bob', 'Conflicting', key)).statusCode).toBe(
        409,
      );
      expect(
        Number(
          (await state.pool!.query('SELECT count(*) FROM issue_entries'))
            .rows[0].count,
        ),
      ).toBe(1);
    });

    it('enforces moderation on every user write and hides content from all public paths', async () => {
      const id = (await create()).json().id;
      const entry = (await comment(id)).json().id;
      const own = await app.inject({
        method: 'PATCH',
        url: `/api/issues/${id}/comments/${entry}`,
        headers: auth('bob'),
        payload: { body: 'Edited safely' },
      });
      expect(own.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/issues/${id}/comments/${entry}`,
            headers: auth(),
            payload: { body: 'Not mine' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/admin/issues/${id}/comments/${entry}`,
            headers: admin,
            payload: { hidden: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ url: `/api/issues/${id}` })).json().entries,
      ).toEqual([]);
      await moderate(id, { state: 'closed', close_reason: 'resolved' });
      expect(
        (await app.inject({ url: `/api/issues/${id}` })).json().entries[0],
      ).toMatchObject({ type: 'closed', close_reason: 'resolved' });
      await moderate(id, { locked: true });
      expect((await comment(id, 'carol')).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/issues/${id}`,
            headers: auth(),
            payload: { title: 'Changed', body: 'Changed' },
          })
        ).statusCode,
      ).toBe(403);
      await moderate(id, { locked: false, state: 'open' });
      await app.inject({
        method: 'PATCH',
        url: `/api/admin/issues/${id}/participants/1`,
        headers: admin,
        payload: { muted: true },
      });
      expect((await comment(id, 'bob', 'Muted reply')).statusCode).toBe(403);
      expect((await create('bob')).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/issues/${id}/comments/${entry}`,
            headers: auth('bob'),
            payload: { body: 'Muted edit' },
          })
        ).statusCode,
      ).toBe(403);
      await app.inject({
        method: 'PATCH',
        url: `/api/admin/issues/${id}/participants/1`,
        headers: admin,
        payload: { muted: false },
      });
      expect((await create('bob')).statusCode).toBe(201);
      await moderate(id, { hidden: true });
      expect((await app.inject({ url: `/api/issues/${id}` })).statusCode).toBe(
        404,
      );
      expect(
        (await app.inject({ url: '/api/issues?mine=true', headers: auth() }))
          .json()
          .items.some((item: { id: number }) => item.id === id),
      ).toBe(false);
      expect((await comment(id, 'carol', 'Hidden reply')).statusCode).toBe(404);
      expect(
        (
          await app.inject({ url: `/api/admin/issues/${id}`, headers: admin })
        ).json().hidden,
      ).toBe(true);
    });

    it('bounds timeline pages, records official replies and treats SQL syntax as literal text', async () => {
      const payload = issue("Synthetic '); DROP TABLE users; --");
      const id = (await create('alice', payload)).json().id;
      await state.pool!.query(
        "INSERT INTO issue_entries(issue_id,actor_kind,type,body,request_key,request_hash) SELECT $1,'official','comment','History '||n,gen_random_uuid(),'synthetic' FROM generate_series(1,60)n",
        [id],
      );
      const latest = (await app.inject({ url: `/api/issues/${id}` })).json();
      expect(latest.entries).toHaveLength(50);
      const older = (
        await app.inject({
          url: `/api/issues/${id}?before=${latest.next_cursor}`,
        })
      ).json();
      expect(older.entries).toHaveLength(10);
      expect(older.next_cursor).toBeNull();
      expect(older.entries.at(-1).id).toBeLessThan(latest.entries[0].id);
      expect(
        (
          await app.inject({
            url: `/api/issues?q=${encodeURIComponent("'); DROP TABLE users; --")}`,
          })
        ).json().total,
      ).toBe(1);
      expect(
        Number(
          (await state.pool!.query('SELECT count(*) FROM users')).rows[0].count,
        ),
      ).toBe(3);
      const reply = await app.inject({
        method: 'POST',
        url: `/api/admin/issues/${id}/comments`,
        headers: admin,
        payload: { body: 'Official update', request_key: randomUUID() },
      });
      expect(reply.statusCode).toBe(201);
      expect(
        (await app.inject({ url: `/api/issues/${id}` })).json().entries.at(-1)
          .author,
      ).toEqual({ kind: 'official', participant_number: null, is_self: false });
    });

    it('enforces the real atomic Redis limit and refuses writes during a Redis outage', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          fixedWindowRateLimit('synthetic:atomic', 2, 60),
        ),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(2);
      const keys = await state.redis!.keys('fwrl:synthetic:atomic:*');
      expect(await state.redis!.ttl(keys[0])).toBeGreaterThan(0);
      state.redis!.disconnect();
      const result = await create();
      expect(result.statusCode).toBe(503);
      expect(
        Number(
          (await state.pool!.query('SELECT count(*) FROM issues')).rows[0]
            .count,
        ),
      ).toBe(0);
      await state.redis!.connect();
    });

    it('does not let an untrusted client rotate its rate-limit bucket through forwarded headers', async () => {
      let last = 0;
      for (let index = 0; index < 121; index++) {
        last = (
          await app.inject({
            url: '/api/issues',
            remoteAddress: '198.51.100.1',
            headers: { 'x-forwarded-for': `203.0.113.${(index % 250) + 1}` },
          })
        ).statusCode;
      }
      expect(last).toBe(429);
    });

    it('preserves account deletion by cascading account owned content and participation', async () => {
      const id = (await create()).json().id;
      await comment(id);
      await state.pool!.query("DELETE FROM users WHERE id='bob'");
      expect(
        (await app.inject({ url: `/api/issues/${id}` })).json().issue
          .comment_count,
      ).toBe(0);
      await state.pool!.query("DELETE FROM users WHERE id='alice'");
      expect((await app.inject({ url: `/api/issues/${id}` })).statusCode).toBe(
        404,
      );
      expect(
        Number(
          (await state.pool!.query('SELECT count(*) FROM issue_participants'))
            .rows[0].count,
        ),
      ).toBe(0);
    });
  },
);
