import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_RUNTIME_POLICY } from '@fateclaw/contracts/memory';
import {
  extractMemoryCandidates,
  type MemoryCandidate,
  type MemorySourceInput,
} from '#modules/memory/extraction';
import type {
  MemoryModelConnection,
  MemoryTextRunner,
} from '#modules/memory/model-client';

const policy = { ...DEFAULT_MEMORY_RUNTIME_POLICY };
const connection: MemoryModelConnection = {
  modelConfigId: 'synthetic-node',
  providerKey: 'synthetic',
  piApi: 'openai-completions',
  model: 'synthetic-model',
  apiKey: 'synthetic-memory-key',
  authMode: 'openai_api_key',
};
const resolveModel = async () => connection;
const source: MemorySourceInput = {
  id: 'source-user',
  revision: 1,
  role: 'user',
  content: '我喜欢喝咖啡。',
  observedAt: '2026-11-01T08:00:00Z',
  subjectId: 'self',
};
const candidate: MemoryCandidate = {
  sourceId: source.id,
  quote: '我喜欢喝咖啡。',
  content: '我喜欢喝咖啡。',
  kind: 'preference',
  assertionType: 'stated',
};
const usage = { inputTokens: 40, outputTokens: 12 };
const output =
  (data: unknown): MemoryTextRunner =>
  async () => ({
    text: JSON.stringify(data),
    usage,
  });
const args = {
  sources: [source],
  existing: [],
  policy,
  resolveModel,
};

describe('evidence-bound memory extraction', () => {
  it('accepts complete canonical user statements and reports usage separately from source input', async () => {
    const runner = vi.fn(output({ candidates: [candidate] }));
    const result = await extractMemoryCandidates({ ...args, runner });
    expect(result.candidates).toEqual([{ ...candidate, subjectId: 'self' }]);
    expect(result.usage).toEqual(usage);
    expect(runner.mock.calls[0][0].purpose).toBe('memory.extract');
    expect(runner.mock.calls[0][0].input).not.toContain(connection.apiKey);
    expect(result).not.toHaveProperty('apiKey');
  });

  it.each(['assistant', 'unknown'])(
    'refuses %s messages as a user fact source',
    async (role) => {
      const result = await extractMemoryCandidates({
        ...args,
        sources: [{ ...source, role: role as MemorySourceInput['role'] }],
        runner: output({ candidates: [candidate] }),
      });
      expect(result.candidates).toEqual([]);
      expect(result.rejected).toEqual({ SOURCE: 1 });
    },
  );

  it.each([
    { ...candidate, sourceId: 'invented-source' },
    { ...candidate, quote: '我不喜欢喝咖啡。' },
    { ...candidate, content: '我在北京工作。' },
    { ...candidate, supersedesId: 'invented-existing-fact' },
    { ...candidate, subjectId: 'another-person' },
    { ...candidate, unexpected: true },
  ])(
    'refuses fabricated bindings, content, prior facts, subjects and malformed entries',
    async (proposed) => {
      const result = await extractMemoryCandidates({
        ...args,
        runner: output({ candidates: [proposed] }),
      });
      expect(result.candidates).toEqual([]);
      expect(Object.values(result.rejected ?? {})).toEqual([1]);
    },
  );

  it('keeps valid candidates when another candidate in the same output is refused', async () => {
    const content = '我对海鲜过敏，要是吃了会起疹子。朋友说我明年结婚。';
    const allergy = '我对海鲜过敏，要是吃了会起疹子。';
    const hearsay = '朋友说我明年结婚。';
    const result = await extractMemoryCandidates({
      ...args,
      sources: [{ ...source, content }],
      runner: output({
        candidates: [
          { ...candidate, quote: hearsay, content: hearsay, kind: 'event' },
          { ...candidate, quote: allergy, content: allergy, kind: 'fact' },
        ],
      }),
    });
    expect(result.candidates.map((item) => item.content)).toEqual([allergy]);
    expect(result.rejected).toEqual({ UNSUPPORTED: 1 });
  });

  it.each([
    ['假如我明年结婚，我会搬家。', '我明年结婚'],
    ['如果我辞职，就去北京。', '如果我辞职，就去北京。'],
    ['我并没有在北京工作。', '北京工作'],
    ['我计划明年结婚。', '我计划明年结婚。'],
    ['模型预测我明年结婚。', '模型预测我明年结婚。'],
    ['朋友说我明年结婚。', '朋友说我明年结婚。'],
    ['算命先生说我克夫。', '算命先生说我克夫。'],
    ['我可能明年结婚。', '我可能明年结婚。'],
    ['我明年结婚。', '我明年结婚。'],
    ['客户说：“我已经结婚。”', '客户说：“我已经结婚。”'],
  ])(
    'refuses hypotheses, hearsay, quoted speech, clipped quotes and plans as events: %s',
    async (content, quote) => {
      const result = await extractMemoryCandidates({
        ...args,
        sources: [{ ...source, content }],
        runner: output({
          candidates: [{ ...candidate, quote, content: quote, kind: 'event' }],
        }),
      });
      expect(result.candidates).toEqual([]);
    },
  );

  it.each([
    '我在「腾讯」工作。',
    '我从事算命行业十年了。',
    '我对海鲜过敏，要是吃了会起疹子。',
    '我可能是O型血。',
    '我以前找人算过命，但我不信。',
  ])('accepts the user’s own statement: %s', async (content) => {
    const result = await extractMemoryCandidates({
      ...args,
      sources: [{ ...source, content }],
      runner: output({
        candidates: [{ ...candidate, quote: content, content, kind: 'fact' }],
      }),
    });
    expect(result.candidates.map((item) => item.content)).toEqual([content]);
  });

  it('retains negation and plans without upgrading them into accomplished events', async () => {
    const content = '我没有结婚。\n我计划明年结婚。';
    const candidates: MemoryCandidate[] = [
      {
        ...candidate,
        quote: '我没有结婚。',
        content: '我没有结婚。',
        kind: 'fact',
      },
      {
        ...candidate,
        quote: '我计划明年结婚。',
        content: '我计划明年结婚。',
        kind: 'plan',
        assertionType: 'plan',
      },
    ];
    const result = await extractMemoryCandidates({
      ...args,
      sources: [{ ...source, content }],
      runner: output({ candidates }),
    });
    expect(result.candidates.map((item) => item.content)).toEqual([
      '我没有结婚。',
      '我计划明年结婚。',
    ]);
    expect(result.candidates[1]).toMatchObject({
      kind: 'plan',
      assertionType: 'plan',
    });
  });

  it('keeps the speaker distinct from a client and requires an explicit allowed subject', async () => {
    const ownerSource: MemorySourceInput = {
      ...source,
      content: '我最近也在找工作。',
      subjectId: 'client',
      speakerSubjectId: 'owner',
      subjectName: '合成客户',
      speakerKind: 'owner',
      subjectKind: 'client',
    };
    const ownerCandidate: MemoryCandidate = {
      ...candidate,
      quote: ownerSource.content,
      content: ownerSource.content,
      kind: 'event',
    };
    for (const subjectId of [undefined, 'client']) {
      const refused = await extractMemoryCandidates({
        ...args,
        sources: [ownerSource],
        runner: output({ candidates: [{ ...ownerCandidate, subjectId }] }),
      });
      expect(refused.rejected).toEqual({ SUBJECT: 1 });
    }
    const result = await extractMemoryCandidates({
      ...args,
      sources: [ownerSource],
      runner: output({
        candidates: [{ ...ownerCandidate, subjectId: 'owner' }],
      }),
    });
    expect(result.candidates[0].subjectId).toBe('owner');
  });

  it('retains stated preferences and decisions without forcing them into accomplished events', async () => {
    const content = '我希望回答简洁。\n我决定明年去北京工作。';
    const candidates: MemoryCandidate[] = [
      { ...candidate, quote: '我希望回答简洁。', content: '我希望回答简洁。' },
      {
        ...candidate,
        quote: '我决定明年去北京工作。',
        content: '我决定明年去北京工作。',
        kind: 'decision',
      },
    ];
    const result = await extractMemoryCandidates({
      ...args,
      sources: [{ ...source, content }],
      runner: output({ candidates }),
    });
    expect(result.candidates.map((item) => item.kind)).toEqual([
      'preference',
      'decision',
    ]);
  });

  it('permits proposals for supplied prior facts without performing any merge', async () => {
    const result = await extractMemoryCandidates({
      ...args,
      existing: [
        {
          id: 'existing',
          content: '我喜欢喝茶。',
          kind: 'preference',
          observedAt: source.observedAt,
        },
      ],
      runner: output({
        candidates: [{ ...candidate, supersedesId: 'existing' }],
      }),
    });
    expect(result.candidates[0].supersedesId).toBe('existing');
  });

  it('accepts a single JSON code fence and surfaces invalid JSON with spent usage', async () => {
    const fenced = await extractMemoryCandidates({
      ...args,
      runner: async () => ({ text: '```json\n{"candidates":[]}\n```', usage }),
    });
    expect(fenced.candidates).toEqual([]);
    await expect(
      extractMemoryCandidates({
        ...args,
        runner: async () => ({ text: '{broken', usage }),
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_MODEL_INVALID_JSON', usage });
  });

  it('rejects oversized complete input before invoking the model', async () => {
    const runner = vi.fn(output({ candidates: [] }));
    await expect(
      extractMemoryCandidates({
        ...args,
        sources: [{ ...source, content: '合成完整陈述。'.repeat(2000) }],
        runner,
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_INPUT_BUDGET_EXCEEDED' });
    expect(runner).not.toHaveBeenCalled();
  });
});
