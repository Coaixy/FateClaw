import {
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { createPiCurrentTimeTool } from './tools/current-time-tool.js';
import { createPiGanzhiByDatetimeTool } from './tools/ganzhi-by-datetime-tool.js';
import { createPiGanzhiReverseTool } from './tools/ganzhi-reverse-tool.js';
import { createPiSkillReadTool } from './tools/skill-read-tool.js';
import type { RequestScope } from '../request-scope.js';
import type { PiToolExecutionRecord } from './types.js';

/**
 * 创建 Pi custom tools 所需的运行时参数。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - readableSkills：本轮授权可读取的 Skill 清单；为空时不暴露 read。
 * - recordExecution：工具执行记录回调。
 * - now：可选时钟函数，用于固定当前时间工具的测试结果。
 * - defaultTimeZone：当前时间工具默认时区。
 *
 * 注意：这里统一注册 FateClaw 暴露给 Pi 的确定性工具。
 */
export interface CreatePiToolsOptions {
  requestScope: RequestScope;
  readableSkills?: Skill[];
  recordExecution(record: PiToolExecutionRecord): void;
  now?: () => Date;
  defaultTimeZone?: string;
}

/**
 * 创建本轮 Pi 会话允许调用的 custom tools。
 *
 * 参数：CreatePiToolsOptions。
 * 返回：Pi coding agent 可注册的工具定义列表。
 * 注意：时间/干支工具默认可用，read 仅在存在授权 Skill 时可用。
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
  ];
  if (options.readableSkills?.length) {
    tools.push(
      createPiSkillReadTool({
        requestScope: options.requestScope,
        readableSkills: options.readableSkills,
        recordExecution: options.recordExecution,
      }),
    );
  }
  return tools;
}
