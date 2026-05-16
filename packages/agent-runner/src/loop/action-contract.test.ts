import { describe, expect, it } from 'vitest';

import {
  buildCapabilityLedger,
  checkFinalization,
  createActionContractRun,
  markRepairRequested,
  recordAction,
  registerRequirement,
} from './action-contract.js';

describe('action contract', () => {
  it('denies finalization until a requirement is satisfied', () => {
    const run = createActionContractRun({
      runId: 'run-1',
      attemptId: 'attempt-1',
      provider: 'openai-compatible',
      model: 'test-model',
    });
    registerRequirement(run, {
      id: 'knowledge.required',
      capability: 'knowledge',
      reason: 'test',
      requiredWhen: 'queryable.length > 0',
      allowSkip: true,
      targets: [{
        skillDir: 'user-skill',
        skillName: 'User Skill',
        sectionTitles: ['Topic'],
      }],
    });

    const first = checkFinalization(run, 'final');
    expect(first.allowed).toBe(false);
    expect(first.repairable).toBe(true);

    markRepairRequested(run, first);
    const second = checkFinalization(run, 'final');
    expect(second.allowed).toBe(false);
    expect(second.repairable).toBe(false);
  });

  it('marks a requirement satisfied by a successful read action', () => {
    const run = createActionContractRun({
      runId: 'run-1',
      attemptId: 'attempt-1',
    });
    registerRequirement(run, {
      id: 'knowledge.required',
      capability: 'knowledge',
      reason: 'test',
      requiredWhen: 'queryable.length > 0',
      allowSkip: true,
      targets: [{
        skillDir: 'user-skill',
        skillName: 'User Skill',
        sectionTitles: ['Topic'],
      }],
    });
    recordAction(run, {
      requirementId: 'knowledge.required',
      action: 'read',
      status: 'success',
      toolName: 'read_knowledge_section',
      target: {
        skillDir: 'user-skill',
        skillName: 'User Skill',
        sectionTitle: 'Topic',
      },
    });

    expect(checkFinalization(run, 'final').allowed).toBe(true);
    expect(buildCapabilityLedger(run)).toEqual(
      expect.objectContaining({
        requirements: [
          expect.objectContaining({
            status: 'satisfied_read',
            targets: [
              expect.objectContaining({
                readSections: ['Topic'],
              }),
            ],
          }),
        ],
      }),
    );
  });
});
