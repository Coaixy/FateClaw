import { describe, expect, it } from 'vitest';

import {
  collectStepOutputs,
  renderWorkflowPrompt,
} from '../../../src/modules/chat/workflow-run-render.js';

describe('renderWorkflowPrompt', () => {
  it('替换 {{input.<key>}} 为本次运行输入', () => {
    const out = renderWorkflowPrompt('他想问:{{input.question}}', {
      input: { question: '今年事业' },
      stepOutputs: {},
    });
    expect(out).toBe('他想问:今年事业');
  });

  it('替换 {{step.<id>.output}} 为该步产出,且容忍空白', () => {
    const out = renderWorkflowPrompt('初断:{{ step.s2.output }}', {
      input: {},
      stepOutputs: { s2: '日主偏弱' },
    });
    expect(out).toBe('初断:日主偏弱');
  });

  it('未知引用与缺失键渲染为空串(不把 {{}} 原样发给模型)', () => {
    const out = renderWorkflowPrompt('[{{input.missing}}][{{step.x.nope}}]', {
      input: {},
      stepOutputs: {},
    });
    expect(out).toBe('[][]');
  });

  it('一条模板里多种引用混用', () => {
    const out = renderWorkflowPrompt(
      '问题:{{input.q}};初断:{{step.s1.output}};深化:{{step.s2.output}}',
      {
        input: { q: '财运' },
        stepOutputs: { s1: '甲', s2: '乙' },
      },
    );
    expect(out).toBe('问题:财运;初断:甲;深化:乙');
  });
});

describe('collectStepOutputs', () => {
  it('从回复消息 id 约定中切出 stepId 并取内容', () => {
    const outputs = collectStepOutputs([
      { id: 'wf-s1-100-aaa_reply', content: '初断结论', timestamp: '2026-06-21T00:00:01Z' },
    ]);
    expect(outputs).toEqual({ s1: '初断结论' });
  });

  it('同一步多条回复取时间戳最新(覆盖重跑/润色)', () => {
    const outputs = collectStepOutputs([
      { id: 'wf-s1-100-aaa_reply', content: '旧版', timestamp: '2026-06-21T00:00:01Z' },
      { id: 'wf-s1-200-bbb_reply', content: '润色后', timestamp: '2026-06-21T00:00:09Z' },
    ]);
    expect(outputs.s1).toBe('润色后');
  });

  it('忽略非工作流消息与非回复消息', () => {
    const outputs = collectStepOutputs([
      { id: 'wf-s1-100-aaa', content: '用户消息(非回复)', timestamp: '2026-06-21T00:00:01Z' },
      { id: 'session-x-1', content: '普通消息', timestamp: '2026-06-21T00:00:02Z' },
      { id: 'wf-s2-100-ccc_reply', content: '深化', timestamp: '2026-06-21T00:00:03Z' },
    ]);
    expect(outputs).toEqual({ s2: '深化' });
  });

  it('stepId 含下划线也能正确切出', () => {
    const outputs = collectStepOutputs([
      { id: 'wf-step_2-100-aaa_reply', content: 'x', timestamp: '2026-06-21T00:00:01Z' },
    ]);
    expect(outputs).toEqual({ step_2: 'x' });
  });
});
