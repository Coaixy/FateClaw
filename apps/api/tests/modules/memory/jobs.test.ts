import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEMORY_RUNTIME_POLICY,
  type MemoryRequestScope,
  type MemoryRuntimePolicy,
} from '@fateclaw/contracts/memory';
import type { MemoryJobRow, MemoryScopeRow } from '#modules/memory/domain';
import { memoryHash } from '#modules/memory/domain';
import { MemoryModelError } from '#modules/memory/model-client';
import {
  changeMemoryJobState,
  claimMemoryJobs,
  processMemoryJob,
  retryMemoryJob,
  splitMemoryExtractionSource,
  startMemoryBackfill,
} from '#modules/memory/jobs';
import {
  estimateMemoryExtractionInput,
  type MemorySourceInput,
} from '#modules/memory/extraction';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  root: {} as MemoryScopeRow,
  job: {} as MemoryJobRow,
  sources: new Map<string, Record<string, unknown>>(),
  policy: {} as MemoryRuntimePolicy,
  excluded: false,
  messages: [] as Array<Record<string, unknown>>,
  priorSource: false,
  insertItem: vi.fn(),
  queue: vi.fn(),
  indexText: vi.fn(),
  capture: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  reauthorize: vi.fn(),
}));

vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => ({ query: mocks.query }),
}));
vi.mock('#modules/memory/policy', () => ({
  getMemoryRuntimePolicy: async () => mocks.policy,
}));
vi.mock('#modules/memory/budget', () => ({
  reserveMemoryBudget: mocks.reserve,
  settleMemoryBudget: mocks.settle,
}));
vi.mock('#modules/memory/pi-contexts', () => ({
  isMemoryPiContextCurrent: async () => true,
}));
vi.mock('#modules/memory/repository', () => ({
  withMemoryTransaction: async (run: (db: unknown) => Promise<unknown>) =>
    run({ query: mocks.query }),
  lockMemoryRoot: async () => mocks.root,
  readMemoryRoot: async () => mocks.root,
  ensureOwnerMemoryScope: async () => mocks.root,
  assertMemorySubject: async () => undefined,
  actorSubjectId: (scope: { ownerUserId: string }) =>
    `self:${scope.ownerUserId}`,
  memorySpaceId: (scope: MemoryRequestScope) =>
    scope.memorySpaceId ?? scope.scopeId,
  hasOwnerMemoryAudience: (scope: MemoryRequestScope) =>
    scope.actorKey === `user:${scope.ownerUserId}` ||
    (scope.ownerMemoryAccess === true &&
      scope.speakerSubjectId === `self:${scope.ownerUserId}`),
  getCurrentMemorySource: async (id: string) => mocks.sources.get(id) ?? null,
  insertMemoryItem: mocks.insertItem,
  indexMemoryText: mocks.indexText,
  queueMemoryJob: mocks.queue,
  captureMemorySource: mocks.capture,
  reauthorizeMemorySourceForBackfill: mocks.reauthorize,
  createMemoryAdmissionScope: vi.fn(),
}));

function job(overrides: Partial<MemoryJobRow> = {}): MemoryJobRow {
  return {
    id: 'job-1',
    owner_user_id: 'owner',
    scope_id: 'scope',
    subject_id: 'self:owner',
    source_id: 'source',
    source_revision: 1,
    request_id: 'request',
    kind: 'extract',
    event_type: 'user_message_committed',
    epoch: 1,
    state: 'running',
    payload: {},
    attempts: 1,
    lease_token: 'lease-1',
    lease_until: new Date(Date.now() + 10_000),
    processed_count: 0,
    total_count: null,
    error_code: null,
    created_at: '2026-11-01T01:00:00Z',
    updated_at: '2026-11-01T01:00:00Z',
    ...overrides,
  };
}

function source(id = 'source', content = '我喜欢喝咖啡。') {
  return {
    id,
    owner_user_id: 'owner',
    scope_id: 'scope',
    subject_id: 'self:owner',
    source_kind: 'message',
    source_role: 'user',
    source_ref: `web:owner:${id}`,
    account_id: 'web:owner',
    message_id: id,
    session_id: 'session',
    revision: 1,
    content_hash: memoryHash(content),
    source_sequence: 1,
    observed_at: '2026-11-01T00:00:00Z',
    epoch: 1,
    learning_enabled: true,
    excluded_at: null,
    extracted_revision: 0,
    content,
    subject_name: '用户本人',
    subject_kind: 'self',
    actor_key: 'user:owner',
    identity_snapshot: {
      scopeId: 'scope',
      ownerUserId: 'owner',
      actorKey: 'user:owner',
      audienceKey: 'owner:owner',
      subjectId: 'self:owner',
      epoch: 1,
      learningEnabled: true,
      recallEnabled: true,
      chatEditingEnabled: true,
      contextGeneration: 0,
      memorySpaceId: 'scope',
      speakerSubjectId: 'self:owner',
      bindingRevision: 1,
      ownerMemoryAccess: true,
    },
  };
}

const result = {
  usage: { inputTokens: 20, outputTokens: 5 },
  modelConfigId: 'node',
  model: 'synthetic-model',
  durationMs: 1,
};
const extraction = () => ({
  ...result,
  candidates: [
    {
      sourceId: 'source',
      subjectId: 'self:owner',
      content: '我喜欢喝咖啡。',
      quote: '我喜欢喝咖啡。',
      kind: 'preference' as const,
      assertionType: 'stated' as const,
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.root = {
    id: 'scope',
    owner_user_id: 'owner',
    parent_scope_id: null,
    actor_key: 'user:owner',
    audience_key: 'owner:owner',
    epoch: 1,
    revision: 1,
    learning_enabled: true,
    recall_enabled: true,
    chat_editing_enabled: true,
    cleared_at: null,
  };
  mocks.job = job();
  mocks.sources = new Map([['source', source()]]);
  mocks.policy = { ...DEFAULT_MEMORY_RUNTIME_POLICY };
  mocks.excluded = false;
  mocks.messages = [];
  mocks.priorSource = false;
  mocks.reserve.mockResolvedValue({
    id: 'reservation',
    day: '2026-11-01',
    purpose: 'language',
    ownerUserId: 'owner',
    tokens: 100,
    jobId: 'job-1',
  });
  mocks.settle.mockResolvedValue(undefined);
  mocks.reauthorize.mockResolvedValue(false);
  mocks.insertItem.mockResolvedValue({ id: 'item-1', revision: 1 });
  mocks.queue.mockResolvedValue('job-1');
  mocks.query.mockImplementation(
    async (sql: string, values: unknown[] = []) => {
      if (
        sql.startsWith('SELECT memory_learning_enabled FROM chat_sessions')
      )
        return { rows: [{ memory_learning_enabled: true }], rowCount: 1 };
      if (sql.includes('memory_budget_reservations'))
        return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT * FROM memory_jobs')) {
        if (
          sql.includes("state='running'") &&
          (mocks.job.state !== 'running' || values[1] !== mocks.job.lease_token)
        )
          return { rows: [], rowCount: 0 };
        return { rows: [{ ...mocks.job }], rowCount: 1 };
      }
      if (
        sql.includes('FROM memory_jobs WHERE scope_id=') &&
        sql.includes("kind='backfill'")
      )
        return {
          rows:
            mocks.job.kind === 'backfill' &&
            ['pending', 'running', 'paused'].includes(mocks.job.state)
              ? [{ ...mocks.job }]
              : [],
        };
      if (sql.startsWith('SELECT * FROM memory_scopes'))
        return { rows: [mocks.root], rowCount: 1 };
      if (sql.includes('FROM memory_exclusions'))
        return {
          rows: mocks.excluded ? [{ exists: 1 }] : [],
          rowCount: mocks.excluded ? 1 : 0,
        };
      if (sql.includes('SELECT i.* FROM memory_items'))
        return { rows: [], rowCount: 0 };
      if (sql.includes('FROM messages m JOIN chat_sessions'))
        return { rows: mocks.messages, rowCount: mocks.messages.length };
      if (sql.startsWith('SELECT id FROM memory_sources'))
        return {
          rows: mocks.priorSource ? [{ id: 'existing-source' }] : [],
          rowCount: mocks.priorSource ? 1 : 0,
        };
      if (sql.startsWith("UPDATE memory_jobs SET state='paused'")) {
        mocks.job = {
          ...mocks.job,
          state: 'paused',
          lease_token: null,
          lease_until: null,
        };
        return { rows: [{ ...mocks.job }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE memory_jobs SET state='pending'")) {
        mocks.job = {
          ...mocks.job,
          state: 'pending',
          attempts: 0,
          error_code: null,
          lease_token: null,
          lease_until: null,
        };
        return { rows: [{ ...mocks.job }], rowCount: 1 };
      }
      if (sql.includes('UPDATE memory_jobs SET state=$3')) {
        if (
          values[1] !== mocks.job.lease_token ||
          mocks.job.state !== 'running'
        )
          return { rows: [], rowCount: 0 };
        const successful = sql.includes('payload=COALESCE');
        mocks.job = {
          ...mocks.job,
          state: values[2] as MemoryJobRow['state'],
          lease_token: null,
          lease_until: null,
          error_code: (successful ? values[6] : values[3]) as string | null,
          ...(successful && values[3]
            ? { payload: JSON.parse(values[3] as string) }
            : {}),
          ...(successful && values[4] !== null
            ? { processed_count: values[4] as number }
            : {}),
          ...(successful && values[5] !== null
            ? { total_count: values[5] as number }
            : {}),
        };
        return { rows: [{ id: mocks.job.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  );
});

describe('durable memory job boundaries', () => {
  it('skips an expired claim before contacting a model or reserving usage', async () => {
    const claimed = { ...mocks.job, lease_token: 'old-lease' };
    const extract = vi.fn(async () => extraction());
    await processMemoryJob(claimed, mocks.policy, { processors: { extract } });
    expect(extract).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.job.state).toBe('running');
    expect(mocks.job.lease_token).toBe('lease-1');
  });

  it('applies canonical evidence and completes the source/job after a current fenced call', async () => {
    const extract = vi.fn(async () => extraction());
    await processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    expect(mocks.job.state).toBe('succeeded');
    expect(mocks.job.processed_count).toBe(1);
    expect(mocks.insertItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quote: '我喜欢喝咖啡。', origin: 'automatic' }),
    );
    expect(extract.mock.calls[0][0].sources[0]).toMatchObject({
      speakerSubjectId: 'self:owner',
      subjectKind: 'self',
    });
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', jobLeaseToken: 'lease-1' }),
    );
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ usage: result.usage }),
    );
  });

  it('pauses a running task and rejects its late model result, then resumes without the old lease', async () => {
    let finish: (value: ReturnType<typeof extraction>) => void = () => {};
    const extract = vi.fn(
      () =>
        new Promise<ReturnType<typeof extraction>>((resolve) => {
          finish = resolve;
        }),
    );
    const processing = processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    await vi.waitFor(() => expect(extract).toHaveBeenCalled());
    expect((await changeMemoryJobState('owner', 'job-1', 'pause')).state).toBe(
      'paused',
    );
    finish(extraction());
    await processing;
    expect(mocks.insertItem).not.toHaveBeenCalled();
    expect(mocks.job.state).toBe('paused');
    expect((await changeMemoryJobState('owner', 'job-1', 'resume')).state).toBe(
      'pending',
    );
    expect(mocks.job.lease_token).toBeNull();
  });

  it('does not apply a model result after an epoch change', async () => {
    const extract = vi.fn(async () => {
      mocks.root = { ...mocks.root, epoch: 2 };
      return extraction();
    });
    await processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    expect(mocks.job.state).toBe('skipped');
    expect(mocks.insertItem).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'])(
    'does not reclassify historical identity when a binding changes %s extraction',
    async (when) => {
      const identity: MemoryRequestScope = {
        scopeId: 'scope',
        ownerUserId: 'owner',
        actorKey: 'user:owner',
        audienceKey: 'owner:owner',
        subjectId: 'self:owner',
        epoch: 1,
        learningEnabled: true,
        recallEnabled: true,
        chatEditingEnabled: true,
        contextGeneration: 0,
        speakerSubjectId: 'self:owner',
        bindingRevision: 1,
      };
      mocks.sources.set('source', { ...source(), identity_snapshot: identity });
      mocks.root.binding_revision = when === 'before' ? 2 : 1;
      const extract = vi.fn(async () => {
        mocks.root.binding_revision = 2;
        return extraction();
      });
      await processMemoryJob(mocks.job, mocks.policy, {
        processors: { extract },
      });
      expect(mocks.job).toMatchObject({
        state: 'skipped',
        error_code: 'MEMORY.BINDING_CHANGED',
      });
      expect(extract).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
      expect(mocks.insertItem).not.toHaveBeenCalled();
    },
  );

  it('does not apply a quote removed from visible source content even when its original hash is unchanged', async () => {
    const original = source();
    const extract = vi.fn(async () => {
      mocks.sources.set('source', { ...original, content: '我喜欢喝茶。' });
      return extraction();
    });
    await processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    expect(mocks.job).toMatchObject({
      state: 'skipped',
      error_code: 'MEMORY.SOURCE_CHANGED',
    });
    expect(mocks.insertItem).not.toHaveBeenCalled();
  });

  it('does not learn revoked or assistant-only evidence', async () => {
    const extract = vi.fn(async () => extraction());
    mocks.excluded = true;
    await processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    expect(mocks.job.state).toBe('skipped');
    expect(extract).not.toHaveBeenCalled();
    mocks.job = job();
    mocks.excluded = false;
    mocks.sources.set('source', { ...source(), source_role: 'assistant' });
    await processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    expect(mocks.job.state).toBe('skipped');
    expect(extract).not.toHaveBeenCalled();
  });

  it('retries model errors only within the configured attempt limit and preserves their spent usage', async () => {
    const error = new MemoryModelError(
      'MEMORY_MODEL_INVALID_JSON',
      '合成模型失败。',
    );
    error.usage = result.usage;
    const extract = vi.fn(async () => {
      throw error;
    });
    await processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    expect(mocks.job).toMatchObject({
      state: 'pending',
      error_code: 'MEMORY_MODEL_INVALID_JSON',
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ usage: result.usage }),
    );
    mocks.job = job({ attempts: mocks.policy.max_attempts });
    await processMemoryJob(mocks.job, mocks.policy, {
      processors: { extract },
    });
    expect(mocks.job.state).toBe('failed');
    expect((await retryMemoryJob('job-1')).state).toBe('pending');
    expect(mocks.job.attempts).toBe(0);
  });

  it('persists failure and propagates unexpected faults to the worker recovery boundary', async () => {
    const unexpected = new Error('synthetic-programming-failure');
    await expect(
      processMemoryJob(mocks.job, mocks.policy, {
        processors: {
          extract: async () => {
            throw unexpected;
          },
        },
      }),
    ).rejects.toBe(unexpected);
    expect(mocks.job).toMatchObject({
      state: 'pending',
      error_code: 'MEMORY.UNEXPECTED',
    });
  });

  it('bounds processors that ignore abort and leaves a retryable durable outcome', async () => {
    await processMemoryJob(
      mocks.job,
      { ...mocks.policy, job_timeout_ms: 20 },
      {
        processors: { extract: () => new Promise(() => {}) },
      },
    );
    expect(mocks.job).toMatchObject({
      state: 'pending',
      error_code: 'MEMORY_MODEL_TIMEOUT',
    });
    expect(mocks.insertItem).not.toHaveBeenCalled();
  });
});

describe('safe extraction batching and durable backfill', () => {
  it('splits complete statements exactly and refuses to detach hypothetical context', () => {
    const content = Array.from(
      { length: 12 },
      (_value, index) => `我的第${index}条完整偏好是喜欢咖啡。`,
    ).join('\n\n');
    const input: MemorySourceInput = {
      id: 'source',
      revision: 1,
      role: 'user',
      content,
      observedAt: '2026-11-01T00:00:00Z',
      subjectId: 'self:owner',
    };
    const minimal = estimateMemoryExtractionInput(
      [{ ...input, content: '一条完整陈述。' }],
      [],
    );
    const policy = { ...mocks.policy, extraction_input_tokens: minimal + 100 };
    const batches = splitMemoryExtractionSource(input, [], policy);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.join('')).toBe(content);
    for (const batch of batches)
      expect(
        estimateMemoryExtractionInput([{ ...input, content: batch }], []),
      ).toBeLessThanOrEqual(policy.extraction_input_tokens);
    expect(() =>
      splitMemoryExtractionSource(
        { ...input, content: `假如我结婚。${content}` },
        [],
        policy,
      ),
    ).toThrow('不能安全分离');
  });

  it('returns an existing active backfill instead of scheduling duplicates', async () => {
    mocks.job = job({ kind: 'backfill', state: 'pending', lease_token: null });
    const returned = await startMemoryBackfill('owner', {});
    expect(returned.id).toBe(mocks.job.id);
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it('rejects calendar dates that Date.parse would roll over', async () => {
    await expect(
      startMemoryBackfill('owner', { from: '2024-02-30T00:00:00Z' }),
    ).rejects.toThrow('回填时间范围无效');
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it('indexes uncertain historical identity without extracting owner facts and resumes from a durable cursor', async () => {
    mocks.job = job({
      kind: 'backfill',
      source_id: null,
      source_revision: null,
      payload: { filter: {}, cutoff: '2026-11-01T00:00:00Z', cursor: null },
    });
    mocks.messages = [
      {
        id: 'old-message',
        account_id: 'web:owner',
        user_id: 'owner',
        session_id: 'session',
        sender: 'legacy-unknown',
        content: '我曾经搬过家。',
        cursor_at: '2026-10-01 00:00:00.000705+00',
        is_from_me: false,
        is_bot_message: false,
        metadata: {
          source_channel: 'wechat',
          wechat_account_id: 'synthetic-wechat',
          sender_hash: 'synthetic-sender',
        },
        admitted_scope: null,
      },
    ];
    await processMemoryJob(mocks.job, mocks.policy);
    expect(mocks.job.state).toBe('succeeded');
    expect(mocks.job.payload.cursor).toEqual({
      at: '2026-10-01 00:00:00.000705+00',
      accountId: 'web:owner',
      id: 'old-message',
    });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.insertItem).not.toHaveBeenCalled();
    expect(mocks.indexText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'source',
        subjectId: expect.stringMatching(/^unresolved:/),
      }),
    );
  });

  it('never re-creates a captured/excluded historical source or a message from before clear', async () => {
    mocks.job = job({
      kind: 'backfill',
      source_id: null,
      source_revision: null,
      payload: { filter: {}, cutoff: '2026-11-01T00:00:00Z' },
    });
    mocks.messages = [
      {
        id: 'old-message',
        account_id: 'web:owner',
        user_id: 'owner',
        session_id: 'session',
        sender: 'legacy',
        content: '我曾经搬过家。',
        cursor_at: '2026-10-01 00:00:00.000705+00',
        is_from_me: false,
        is_bot_message: false,
        metadata: null,
        admitted_scope: null,
      },
    ];
    mocks.priorSource = true;
    await processMemoryJob(mocks.job, mocks.policy);
    expect(mocks.indexText).not.toHaveBeenCalled();
    mocks.job = job({
      kind: 'backfill',
      source_id: null,
      source_revision: null,
      payload: { filter: {}, cutoff: '2026-11-01 00:00:00+00' },
    });
    mocks.priorSource = false;
    mocks.root.cleared_at = '2026-10-02T00:00:00Z';
    mocks.messages = [];
    await processMemoryJob(mocks.job, mocks.policy);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.indexText).not.toHaveBeenCalled();
  });

  it('does not claim tasks when the global policy is disabled', async () => {
    expect(await claimMemoryJobs({ ...mocks.policy, enabled: false })).toEqual(
      [],
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
