import { sendMessage } from '../tools/conversation/send-message.js';
import { readMemory } from '../tools/memory/read.js';
import { writeMemory } from '../tools/memory/write.js';
import { listReminders } from '../tools/reminder/list.js';
import { manageReminder } from '../tools/reminder/manage.js';
import { scheduleReminder } from '../tools/reminder/schedule.js';
import { convertCalendar } from '../tools/utility/convert-calendar.js';
import { convertTime } from '../tools/utility/convert-time.js';
import { generateRandom } from '../tools/utility/generate-random.js';
import { getTimeDetail } from '../tools/utility/get-time-detail.js';
import { recallHistory } from '../tools/utility/recall-history.js';
import { reverseBazi } from '../tools/utility/reverse-bazi.js';
import type { ToolDefinition, ToolExecutionMode, ToolSpec } from '../types.js';

export const PI_DIRECT_TOOL_SPECS: ToolSpec[] = [
  sendMessage,
  readMemory,
  writeMemory,
  scheduleReminder,
  listReminders,
  manageReminder,
  getTimeDetail,
  convertTime,
  recallHistory,
  convertCalendar,
  reverseBazi,
  generateRandom,
];

const PI_DIRECT_TOOL_SPEC_BY_NAME = new Map<string, ToolSpec>(
  PI_DIRECT_TOOL_SPECS.map((spec) => [spec.definition.function.name, spec]),
);

export function getPiDirectToolSpec(name: string): ToolSpec | undefined {
  return PI_DIRECT_TOOL_SPEC_BY_NAME.get(name);
}

export function listPiDirectToolSpecs(): ToolSpec[] {
  return [...PI_DIRECT_TOOL_SPECS];
}

export function getPiDirectToolDefinition(
  name: string,
): ToolDefinition | undefined {
  return getPiDirectToolSpec(name)?.definition;
}

export function getPiDirectToolExecutionMode(
  name: string,
): ToolExecutionMode | undefined {
  return getPiDirectToolSpec(name)?.executionMode;
}

export function listPiDirectToolDefinitions(): ToolDefinition[] {
  return PI_DIRECT_TOOL_SPECS.map((spec) => spec.definition);
}

export function getPiDirectToolNames(): string[] {
  return PI_DIRECT_TOOL_SPECS.map((spec) => spec.definition.function.name);
}

export function isPiDirectToolName(name: string): boolean {
  return PI_DIRECT_TOOL_SPEC_BY_NAME.has(name);
}
