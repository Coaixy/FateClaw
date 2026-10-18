import {
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { createPiCurrentTimeTool } from '#agent/pi-runtime/tools/current-time-tool';
import { createPiGanzhiByDatetimeTool } from '#agent/pi-runtime/tools/ganzhi-by-datetime-tool';
import { createPiGanzhiReverseTool } from '#agent/pi-runtime/tools/ganzhi-reverse-tool';
import { createPiSessionBoardTool } from '#agent/pi-runtime/tools/session-board-tool';
import { createPiSkillGrepTool } from '#agent/pi-runtime/tools/skill-grep-tool';
import { createPiSkillReadTool } from '#agent/pi-runtime/tools/skill-read-tool';
import {
  createPiSoulEditTool,
  createPiSoulReadTool,
} from '#agent/pi-runtime/tools/soul-tool';
import type { RequestScope } from '#agent/request-scope';
import type { PiToolExecutionRecord } from './types.js';
import type { SessionBoardContext } from '#agent/types';
import type { SoulStore } from '#agent/deps';

/**
 * 创建 Pi custom tools 所需的运行时参数。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - readableSkills：本轮授权可检索/读取的 Skill 清单；为空时不暴露 grep/read。
 * - sessionBoards：本轮授权给 Pi 读取的会话盘面集合；为空时不暴露 get_session_board。
 * - accountId：当前 agent-runtime 账号 ID，用于读写 Dashboard 维护的唯一 Soul。
 * - soulStore：Soul 读写存储。
 * - soulEditEnabled：是否允许本轮注册 edit_soul；默认开启用于兼容测试和历史调用。
 * - recordExecution：工具执行记录回调。
 * - now：可选时钟函数，用于固定当前时间工具的测试结果。
 * - defaultTimeZone：当前时间工具默认时区。
 *
 * 注意：这里统一注册 FateClaw 暴露给 Pi 的受控工具；写入型工具必须在自身实现中做权限和意图校验。
 */
export interface CreatePiToolsOptions {
  requestScope: RequestScope;
  readableSkills?: Skill[];
  sessionBoards?: SessionBoardContext[];
  accountId: string;
  soulStore: SoulStore;
  soulEditEnabled?: boolean;
  recordExecution(record: PiToolExecutionRecord): void;
  now?: () => Date;
  defaultTimeZone?: string;
}

/**
 * 创建本轮 Pi 会话允许调用的 custom tools。
 *
 * 参数：CreatePiToolsOptions。
 * 返回：Pi coding agent 可注册的工具定义列表。
 * 注意：时间/干支/Soul 工具默认可用；Skill grep/read 和盘面工具仅在存在授权资源时可用。
 */
export function createPiCustomTools(
  options: CreatePiToolsOptions,
): PiToolDefinition[] {
  const tools: PiToolDefinition[] = [
    createPiCurrentTimeTool({
      requestScope: options.requestScope,
      recordExecution: options.recordExecution,
      now: options.now,
      defaultTimeZone: options.defaultTimeZone,
    }),
    createPiGanzhiByDatetimeTool({
      requestScope: options.requestScope,
      recordExecution: options.recordExecution,
    }),
    createPiGanzhiReverseTool({
      requestScope: options.requestScope,
      recordExecution: options.recordExecution,
    }),
    createPiSoulReadTool({
      requestScope: options.requestScope,
      recordExecution: options.recordExecution,
      accountId: options.accountId,
      soulStore: options.soulStore,
      soulEditEnabled: options.soulEditEnabled,
    }),
  ];
  if (options.soulEditEnabled ?? true) {
    tools.push(
      createPiSoulEditTool({
        requestScope: options.requestScope,
        recordExecution: options.recordExecution,
        accountId: options.accountId,
        soulStore: options.soulStore,
        soulEditEnabled: options.soulEditEnabled,
      }),
    );
  }
  if (options.readableSkills?.length) {
    tools.push(
      createPiSkillGrepTool({
        requestScope: options.requestScope,
        readableSkills: options.readableSkills,
        recordExecution: options.recordExecution,
      }),
      createPiSkillReadTool({
        requestScope: options.requestScope,
        readableSkills: options.readableSkills,
        recordExecution: options.recordExecution,
      }),
    );
  }
  if (options.sessionBoards?.length) {
    tools.push(
      createPiSessionBoardTool({
        requestScope: options.requestScope,
        sessionBoards: options.sessionBoards,
        recordExecution: options.recordExecution,
      }),
    );
  }
  return tools;
}
