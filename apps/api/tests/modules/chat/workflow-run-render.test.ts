import { describe, expect, it } from 'vitest';

import {
  collectNodeOutputs,
  renderWorkflowPrompt,
} from '../../../src/modules/chat/workflow-run-render.js';

describe('renderWorkflowPrompt', () => {
  it('替换 {{input.<key>}} 为本次运行输入', () => {
    const out = renderWorkflowPrompt('他想问:{{input.question}}', {
      input: { question: '今年事业' },
      nodeOutputs: {},
    });
    expect(out).toBe('他想问:今年事业');
  });

  it('替换 {{node.<id>.output}} 为该节点产出,且容忍空白', () => {
    const out = renderWorkflowPrompt('初断:{{ node.n2.output }}', {
      input: {},
      nodeOutputs: { n2: '日主偏弱' },
    });
    expect(out).toBe('初断:日主偏弱');
  });

  it('未知引用与缺失键渲染为空串(不把 {{}} 原样发给模型)', () => {
    const out = renderWorkflowPrompt('[{{input.missing}}][{{node.x.nope}}]', {
      input: {},
      nodeOutputs: {},
    });
    expect(out).toBe('[][]');
  });

  it('一条模板里多种引用混用(汇总节点引多个上游)', () => {
    const out = renderWorkflowPrompt(
      '问题:{{input.q}};格局派:{{node.n1.output}};用神派:{{node.n2.output}}',
      {
        input: { q: '财运' },
        nodeOutputs: { n1: '甲', n2: '乙' },
      },
    );
    expect(out).toBe('问题:财运;格局派:甲;用神派:乙');
  });
});

describe('collectNodeOutputs', () => {
  it('从回复消息 id 约定中切出 nodeId 并取内容', () => {
    const outputs = collectNodeOutputs([
      { id: 'wf-n1-100-aaa_reply', content: '初断结论', timestamp: '2026-06-21T00:00:01Z' },
    ]);
    expect(outputs).toEqual({ n1: '初断结论' });
  });

  it('同一节点多条回复取时间戳最新(覆盖重跑/润色)', () => {
    const outputs = collectNodeOutputs([
      { id: 'wf-n1-100-aaa_reply', content: '旧版', timestamp: '2026-06-21T00:00:01Z' },
      { id: 'wf-n1-200-bbb_reply', content: '润色后', timestamp: '2026-06-21T00:00:09Z' },
    ]);
    expect(outputs.n1).toBe('润色后');
  });

  it('忽略非工作流消息、非回复消息与盘面消息', () => {
    const outputs = collectNodeOutputs([
      { id: 'wf-n1-100-aaa', content: '用户消息(非回复)', timestamp: '2026-06-21T00:00:01Z' },
      { id: 'wf-board-n1-100-zzz', content: '盘面(非回复)', timestamp: '2026-06-21T00:00:01Z' },
      { id: 'session-x-1', content: '普通消息', timestamp: '2026-06-21T00:00:02Z' },
      { id: 'wf-n2-100-ccc_reply', content: '深化', timestamp: '2026-06-21T00:00:03Z' },
    ]);
    expect(outputs).toEqual({ n2: '深化' });
  });

  it('nodeId 含下划线也能正确切出', () => {
    const outputs = collectNodeOutputs([
      { id: 'wf-node_2-100-aaa_reply', content: 'x', timestamp: '2026-06-21T00:00:01Z' },
    ]);
    expect(outputs).toEqual({ node_2: 'x' });
  });
});
