import { describe, expect, it } from 'vitest';

import { createRequestScope } from './request-scope.js';
import { runToolUse } from './run-tool-use.js';
import type { ToolRegistrySnapshot } from './types.js';

function makeLiuyao(position: number, yaoValue: number, isMoving = false) {
  return {
    position,
    yaoValue,
    isMoving,
    tianGan: '己',
    diZhi: ['卯', '巳', '未', '酉', '亥', '丑'][position - 1],
    wuXing: ['木', '火', '土', '金', '水', '土'][position - 1],
    liuQin: ['子孙', '妻财', '官鬼', '父母', '兄弟', '子孙'][position - 1],
    liuShou: ['青龙', '朱雀', '勾陈', '螣蛇', '白虎', '玄武'][position - 1],
    shiYing: position === 1 ? '世' : position === 4 ? '应' : '',
  };
}

const liuyaoBoard = {
  method: 'manual',
  question: '测试问题',
  ganZhiYear: { gz: '丙午' },
  ganZhiMonth: { gz: '壬辰' },
  ganZhiDay: { gz: '辛酉' },
  ganZhiHour: { gz: '乙未' },
  dayKong: '子丑',
  hourKong: '辰巳',
  monthJian: '壬辰',
  dongYaoCount: 1,
  benGua: {
    guaName: '既济',
    palace: '坎',
    yaoList: Array.from({ length: 6 }, (_, index) =>
      makeLiuyao(index + 1, index === 2 ? 6 : 7, index === 2),
    ),
  },
  zhiGua: {
    guaName: '随',
    palace: '震',
    yaoList: Array.from({ length: 6 }, (_, index) =>
      makeLiuyao(index + 1, 7, false),
    ),
  },
};

function toolRegistry(output: string): ToolRegistrySnapshot {
  return {
    toolDefinitions: [],
    buildToolPrompts: () => '',
    executeTool: async () => ({ output }),
    getExecutionMode: () => 'serial',
    getProtectedToolNames: () => new Set(),
  };
}

describe('runToolUse formatter observability', () => {
  it('persists formatter modelOutput in transcript and trace without replacing raw JSON', async () => {
    const scope = createRequestScope();
    const rawOutput = JSON.stringify(liuyaoBoard);

    const { result, artifact, skillContextEntry } = await runToolUse(
      {
        id: 'tool-call-1',
        toolName: 'run_skill_script',
        source: 'model',
        args: {
          skill_name: 'iching-paipan',
          script: 'paipan.js',
        },
      },
      {
        requestScope: scope,
        toolRegistry: toolRegistry(rawOutput),
      },
    );

    expect(result.modelOutput).toContain('【六爻排盘 AI摘要】');
    expect(result.output).toBe(rawOutput);
    expect(artifact?.rawOutput).toBe(rawOutput);
    expect(skillContextEntry?.output).toBe(rawOutput);

    const transcriptResult = scope.transcript.find(
      (event) => event.type === 'tool_result',
    );
    expect(transcriptResult).toEqual(
      expect.objectContaining({
        output: rawOutput,
        modelOutput: expect.stringContaining('#六爻'),
      }),
    );

    const traceResult = scope.traceEvents.find(
      (event) => event.type === 'tool_result',
    );
    expect(traceResult).toEqual(
      expect.objectContaining({
        output: rawOutput.slice(0, 200),
        modelOutputPreview: expect.stringContaining('#六爻'),
        modelOutputBytes: expect.any(Number),
      }),
    );
  });
});
