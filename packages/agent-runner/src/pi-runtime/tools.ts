import {
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { createPiSkillReadTool } from './skill-read-tool.js';
import type { RequestScope } from '../request-scope.js';
import type { PiToolExecutionRecord } from './types.js';

export interface CreatePiToolsOptions {
  requestScope: RequestScope;
  readableSkills?: Skill[];
  recordExecution(record: PiToolExecutionRecord): void;
}

export function createPiCustomTools(
  options: CreatePiToolsOptions,
): PiToolDefinition[] {
  const tools: PiToolDefinition[] = [];
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
