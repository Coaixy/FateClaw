import { describe, expect, it } from 'vitest';
import type { PiSessionBase, PiSessionSnapshot } from '../src/agent/index.js';
import {
  createPiSessionFrame,
  hashPiMessages,
  restorePiSessionFrame,
} from '../src/agent/session.js';

function snapshot(messages: unknown[]): PiSessionSnapshot {
  return {
    persisted: true,
    provider: 'synthetic',
    model: 'synthetic',
    userPrompt: 'synthetic',
    systemPrompt: 'synthetic',
    appendSystemPrompt: [],
    allowedTools: [],
    readableSkills: [],
    messageCount: messages.length,
    messages,
  };
}

describe('incremental Pi sessions', () => {
  it('restores every turn across periodic checkpoints with bounded history duplication', () => {
    let base: PiSessionBase | undefined;
    let restored: PiSessionSnapshot | undefined;
    let completeBytes = 0;
    let frameBytes = 0;
    const messages: unknown[] = [];
    for (let turn = 0; turn < 64; turn++) {
      messages.push({ role: 'user', content: `${turn}:${'x'.repeat(512)}` });
      const current = snapshot([...messages]);
      const frame = createPiSessionFrame(current, base);
      expect(frame.kind).toBe(turn % 16 === 0 ? 'checkpoint' : 'delta');
      restored = restorePiSessionFrame(frame, restored);
      expect(restored.messages).toEqual(messages);
      completeBytes += Buffer.byteLength(JSON.stringify(current));
      frameBytes += Buffer.byteLength(JSON.stringify(frame));
      base = {
        requestId: `request-${turn}`,
        messagesHash: frame.messagesHash,
        messageCount: frame.messageCount,
        checkpointDepth: frame.checkpointDepth,
      };
    }
    expect(frameBytes).toBeLessThan(completeBytes / 4);
  });

  it('starts a new checkpoint after compaction changes the previous message prefix', () => {
    const first = createPiSessionFrame(
      snapshot([{ role: 'user', content: 'old' }]),
    );
    const frame = createPiSessionFrame(
      snapshot([{ role: 'user', content: 'summary' }]),
      {
        requestId: 'old',
        messageCount: first.messageCount,
        messagesHash: first.messagesHash,
        checkpointDepth: 0,
      },
    );
    expect(frame.kind).toBe('checkpoint');
    expect(restorePiSessionFrame(frame).messages).toEqual([
      { role: 'user', content: 'summary' },
    ]);
  });

  it('survives JSONB key ordering and rejects missing or corrupted dependencies', () => {
    const first = snapshot([{ role: 'user', content: 'synthetic' }]);
    const base = {
      requestId: 'first',
      messageCount: 1,
      messagesHash: hashPiMessages(first.messages),
      checkpointDepth: 0,
    };
    const delta = createPiSessionFrame(
      snapshot([...first.messages, { role: 'assistant', content: 'answer' }]),
      base,
    );
    expect(hashPiMessages([{ content: 'synthetic', role: 'user' }])).toBe(
      base.messagesHash,
    );
    expect(() => restorePiSessionFrame(delta)).toThrow('base');
    expect(() =>
      restorePiSessionFrame({ ...delta, messages: [] }, first),
    ).toThrow('integrity');
    expect(
      restorePiSessionFrame(
        delta,
        snapshot([{ content: 'synthetic', role: 'user' }]),
      ).messageCount,
    ).toBe(2);
  });
});
