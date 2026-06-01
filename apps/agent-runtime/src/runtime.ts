import type { AgentRuntimeDeps } from './deps.js';
import { getDefaultAgentRuntimeDeps } from './deps.js';

export interface RequestRuntime {
  deps: AgentRuntimeDeps;
}

export interface CreateRequestRuntimeOptions {
  skillsDir?: string;
  logDiagnostics?: boolean;
  deps?: AgentRuntimeDeps;
}

export function createRequestRuntime(
  options: CreateRequestRuntimeOptions = {},
): RequestRuntime {
  return {
    deps: options.deps ?? getDefaultAgentRuntimeDeps(),
  };
}
