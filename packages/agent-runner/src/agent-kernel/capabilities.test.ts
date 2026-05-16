import { describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeDeps } from '../deps.js';
import type { ToolRegistrySnapshot } from '../types.js';
import { createCapabilityCatalog } from './capabilities.js';

function toolRegistry(names: string[]): ToolRegistrySnapshot {
  return {
    toolDefinitions: names.map((name) => ({
      type: 'function',
      function: {
        name,
        description: `${name} description`,
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    })),
    buildToolPrompts: () =>
      names.map((name) => `### ${name}\n${name} prompt`).join('\n\n'),
    executeTool: vi.fn(async () => ({ output: 'ok' })),
    getExecutionMode: () => 'serial',
    getProtectedToolNames: () => new Set<string>(),
  };
}

describe('createCapabilityCatalog', () => {
  it('exposes xuanxue interpretation and knowledge tools to interpret specialist', async () => {
    const catalog = await createCapabilityCatalog({
      baseRegistry: toolRegistry([
        'interpret_xuanxue',
        'list_knowledge_sections',
        'read_knowledge_section',
      ]),
      deps: {
        skillCatalog: {
          listOfficialSkillMetadata: () => [],
          listEnabledSkillNames: vi.fn(async () => []),
        },
      } as unknown as AgentRuntimeDeps,
    });

    const registry = catalog.createRegistryForSpecialist(
      'xuanxue-interpret-agent',
    );

    expect(registry.toolDefinitions.map((tool) => tool.function.name).sort())
      .toEqual([
        'interpret_xuanxue',
        'list_knowledge_sections',
        'read_knowledge_section',
      ]);
    expect(registry.buildToolPrompts()).toContain('read_knowledge_section');
  });
});
