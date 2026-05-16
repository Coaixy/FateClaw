import type { AgentRuntimeDeps } from './deps.js';
import { getDefaultAgentRuntimeDeps } from './deps.js';
import { SKILLS_DIR } from './paths.js';
import { createToolRegistry } from './tools/registry.js';
import type { ToolRegistrySnapshot } from './types.js';

export interface RequestRuntime {
  toolRegistry: ToolRegistrySnapshot;
  deps: AgentRuntimeDeps;
}

export interface CreateRequestRuntimeOptions {
  skillsDir?: string;
  logDiagnostics?: boolean;
  deps?: AgentRuntimeDeps;
}

// 缓存 toolRegistry：常驻 daemon 中 SKILLS_DIR 内容不会在运行时变化，
// 每请求 readdirSync 整个目录是无意义的同步 I/O 浪费。
// key = `${skillsDir}|${depsId}`：自定义 deps（如 outboxQueue）需要独立缓存。
const registryCache = new WeakMap<
  AgentRuntimeDeps,
  Map<string, ToolRegistrySnapshot>
>();

export function createRequestRuntime(
  options: CreateRequestRuntimeOptions = {},
): RequestRuntime {
  const deps = options.deps ?? getDefaultAgentRuntimeDeps();
  const skillsDir = options.skillsDir ?? SKILLS_DIR;
  const logDiagnostics = options.logDiagnostics ?? false;

  let perDepsCache = registryCache.get(deps);
  if (!perDepsCache) {
    perDepsCache = new Map();
    registryCache.set(deps, perDepsCache);
  }
  const cacheKey = `${skillsDir}|${logDiagnostics ? 'diag' : 'normal'}`;

  let toolRegistry = perDepsCache.get(cacheKey);
  if (!toolRegistry) {
    toolRegistry = createToolRegistry({
      skillsDir,
      logDiagnostics,
      deps,
    });
    perDepsCache.set(cacheKey, toolRegistry);
  }

  return { deps, toolRegistry };
}
