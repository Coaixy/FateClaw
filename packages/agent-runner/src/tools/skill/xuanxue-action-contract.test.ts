import { afterEach, describe, expect, it } from 'vitest';

import {
  buildXuanxueKnowledgeProvenanceLabel,
  createXuanxueActionContract,
  ensureXuanxueFinalizationAllowed,
  recordXuanxueKnowledgeSkip,
  recordXuanxueKnowledgeToolResult,
  XuanxueContractFinalizationError,
} from './xuanxue-action-contract.js';
import type { KnowledgeSkillBundle } from './xuanxue-knowledge.js';

const bundle: KnowledgeSkillBundle = {
  skill_dir: 'user-liuyao-money',
  skill_name: '六爻财运经营',
  usage_mode: 'reference_only',
  category: '六爻',
  category_normalized: '六爻',
  sections: [{
    title: '财运总论',
    body: '财运先看财源结构。',
    level: 2,
    summary: '财运先看财源结构。',
  }],
};

describe('xuanxue action contract', () => {
  afterEach(() => {
    delete process.env.XUANXUE_ACTION_CONTRACT_ENFORCEMENT;
  });

  it('requires a read or valid skip when queryable knowledge exists', () => {
    const contract = createXuanxueActionContract({ queryable: [bundle] });
    expect(contract).toBeTruthy();

    expect(() =>
      ensureXuanxueFinalizationAllowed({
        contract,
        mode: 'final',
        allowRepair: false,
      }),
    ).toThrow(XuanxueContractFinalizationError);
  });

  it('accepts a successful authorized read and exposes skill-only provenance', () => {
    const contract = createXuanxueActionContract({ queryable: [bundle] });

    recordXuanxueKnowledgeToolResult({
      contract,
      toolName: 'read_knowledge_section',
      toolArgs: {
        skill_dir: 'user-liuyao-money',
        section_title: '财运总论',
      },
      result: {
        output: JSON.stringify({
          skill_dir: 'user-liuyao-money',
          section_title: '财运总论',
          body: '财运先看财源结构。',
        }),
      },
    });

    expect(
      ensureXuanxueFinalizationAllowed({ contract, mode: 'final' }).allowed,
    ).toBe(true);
    expect(buildXuanxueKnowledgeProvenanceLabel(contract)).toBe(
      '参考：六爻财运经营',
    );
  });

  it('rejects generic skip reasons', () => {
    const contract = createXuanxueActionContract({ queryable: [bundle] });
    const result = recordXuanxueKnowledgeSkip({
      contract,
      toolArgs: {
        reason: 'not needed',
        considered_skill_dirs: ['user-liuyao-money'],
        user_topic: '财运',
        available_topic: '财运总论',
        why_not_applicable: 'not relevant',
      },
    });

    expect(result.isError).toBe(true);
    expect(() =>
      ensureXuanxueFinalizationAllowed({
        contract,
        mode: 'final',
        allowRepair: false,
      }),
    ).toThrow(XuanxueContractFinalizationError);
  });

  it('allows a concrete skip reason', () => {
    const contract = createXuanxueActionContract({ queryable: [bundle] });
    const result = recordXuanxueKnowledgeSkip({
      contract,
      toolArgs: {
        reason: '用户只问出生时间格式，不涉及财运判断规则。',
        considered_skill_dirs: ['user-liuyao-money'],
        user_topic: '出生时间格式',
        available_topic: '六爻财运经营判断',
        why_not_applicable: '该知识库只覆盖财运经营取象，本轮没有财运或经营问题。',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(
      ensureXuanxueFinalizationAllowed({ contract, mode: 'final' }).allowed,
    ).toBe(true);
  });
});
