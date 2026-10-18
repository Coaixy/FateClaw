import {
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type {
  PaipanCaller,
  PaipanOperation,
  PaipanResult,
} from '@fateclaw/contracts/agent/paipan';

import type { SessionBoardContext } from '#agent/types';
import { getJingzhanPrompt } from '#agent/pi-runtime/prompts/jingzhan';
import {
  makeToolResponder,
  type PiToolRuntimeOptions,
} from './tool-execution.js';
import { buildSessionBoardDetail } from './session-board-tool.js';
import { toJsonOutput } from './param-utils.js';

const parameters = Type.Object({
  mode: Type.Union([Type.Literal('catalog'), Type.Literal('create')], {
    description:
      'catalog 查询可用盘种及参数；create 按参数起盘并保存到当前会话。',
  }),
  skill: Type.Optional(
    Type.String({
      description:
        '盘种标识，来自 catalog 的 skill。create 时必填；catalog 时可用于筛选。',
    }),
  ),
  input: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'create 时必填；字段与类型必须符合 catalog 返回的 parameters。',
    }),
  ),
});

export function createPiPaipanTool(
  options: PiToolRuntimeOptions & {
    paipan: PaipanCaller;
    sessionBoards: SessionBoardContext[];
  },
): ToolDefinition {
  return defineTool({
    name: 'create_paipan',
    label: 'create_paipan',
    description:
      '查询可用排盘方法与参数，或调用 FateClaw 排盘引擎生成真实盘面并保存到当前会话。支持八字、六爻、经占、梅花易数、奇门、大六壬和紫微；实际可用盘种以 catalog 为准。',
    promptSnippet:
      'Use create_paipan to discover chart parameters and create a saved chart directly in this conversation.',
    promptGuidelines: [
      '用户明确要求起盘、起卦或根据出生信息生成命盘时，先用 mode=catalog 读取对应盘种的参数，再用 mode=create 执行。',
      '只使用用户明确提供或本轮已授权客户档案中的信息；缺少必填信息、公历农历或时辰有歧义时先追问，不要猜测。',
      '需要当前时刻时先调用 get_current_time，明确年月日时分后再起盘；农历生日先通过 get_ganzhi_by_datetime 转换为公历。',
      '除非用户明确选择，先询问随机起卦方式，不要因 catalog 中存在默认值就替用户选择随机筮法。',
      '创建成功后可直接基于返回的盘面事实解读；后续追问使用 get_session_board 读取同一盘面，不要重复起卦。',
      '盘面已由 API 保存，不要在回复中重新输出盘面 JSON；起盘失败时说明原因或补问信息，不得编造盘面。',
    ],
    parameters,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const respond = makeToolResponder({
        options,
        toolCallId,
        toolName: 'create_paipan',
        params,
        traceType: 'pi_paipan_completed',
        startedAt: Date.now(),
      });
      const finish = (fields: Record<string, unknown> & { isError: boolean }) =>
        respond({ ...fields, output: toJsonOutput(fields) });
      let operation: PaipanOperation;
      const skill = params.skill?.trim();
      if (params.mode === 'catalog') {
        operation = { mode: 'catalog', ...(skill ? { skill } : {}) };
      } else if (
        params.mode === 'create' &&
        skill &&
        params.input &&
        typeof params.input === 'object' &&
        !Array.isArray(params.input)
      ) {
        operation = { mode: 'create', skill, input: params.input, toolCallId };
      } else {
        return finish({
          isError: true,
          error:
            '起盘需要 mode=create、skill 和有效的 input；请先查询 catalog 并补齐参数',
        });
      }
      let result: PaipanResult;
      try {
        result = await options.paipan(operation, signal);
      } catch {
        return finish({
          isError: true,
          error:
            '起盘服务暂时不可用；请检查会话中是否已生成盘面，不要自动重复起卦',
        });
      }
      if (!result.ok)
        return finish({
          isError: true,
          error: result.error,
          code: result.code,
        });
      if (result.mode === 'catalog')
        return finish({
          isError: false,
          mode: 'catalog',
          catalog: result.catalog,
        });

      for (const board of options.sessionBoards) board.isCurrent = false;
      const index = options.sessionBoards.findIndex(
        (board) => board.sourceMessageId === result.board.sourceMessageId,
      );
      const current = { ...result.board, isCurrent: true };
      if (index >= 0) options.sessionBoards[index] = current;
      else options.sessionBoards.push(current);
      return finish({
        isError: false,
        mode: 'create',
        saved: true,
        board: buildSessionBoardDetail(
          current,
          index >= 0 ? index : options.sessionBoards.length - 1,
        ),
        interpretationGuidance: getJingzhanPrompt(current.skill),
      });
    },
  });
}
