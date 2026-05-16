import { describe, expect, it } from 'vitest';

import { buildConversationCapabilityLedger } from './capability-ledger.js';

describe('conversation capability ledger', () => {
  it('materializes contract trace events into a compact ledger', () => {
    const ledger = buildConversationCapabilityLedger([
      {
        type: 'contract_requirement_registered',
        contractVersion: 1,
        runId: 'run-1',
        attemptId: 'attempt-1',
        requirementId: 'xuanxue.queryable_knowledge',
        provider: 'openai-compatible',
        model: 'test-model',
        payload: {
          capability: 'knowledge',
          targets: [
            {
              skillDir: 'user-liuyao-money',
              skillName: '六爻财运经营',
              sectionCount: 1,
            },
          ],
        },
      },
      {
        type: 'contract_action_recorded',
        contractVersion: 1,
        runId: 'run-1',
        attemptId: 'attempt-1',
        requirementId: 'xuanxue.queryable_knowledge',
        payload: {
          action: 'read',
          status: 'success',
          toolName: 'read_knowledge_section',
          target: {
            skillDir: 'user-liuyao-money',
            skillName: '六爻财运经营',
            sectionTitle: '财运总论',
          },
        },
      },
      {
        type: 'contract_finalization_checked',
        contractVersion: 1,
        runId: 'run-1',
        attemptId: 'attempt-1',
        payload: {
          mode: 'final',
          allowed: true,
          deniedRequirementIds: [],
        },
      },
    ]);

    expect(ledger).toEqual({
      schemaVersion: 1,
      runs: [
        expect.objectContaining({
          runId: 'run-1',
          provider: 'openai-compatible',
          model: 'test-model',
          requirements: [
            expect.objectContaining({
              requirementId: 'xuanxue.queryable_knowledge',
              status: 'satisfied_read',
              targets: [
                expect.objectContaining({
                  skillDir: 'user-liuyao-money',
                  readSections: ['财运总论'],
                }),
              ],
            }),
          ],
          events: expect.objectContaining({
            registered: 1,
            read: 1,
            denied: 0,
          }),
        }),
      ],
    });
  });

  it('returns null when no contract trace events exist', () => {
    expect(
      buildConversationCapabilityLedger([{ type: 'tool_call' }]),
    ).toBeNull();
  });
});
