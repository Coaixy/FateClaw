import type { AgentRuntimeDeps } from '../deps.js';
import { formatParamSignature } from '../skill-param-validator.js';
import type { ToolDefinition, ToolRegistrySnapshot } from '../types.js';
import type { SpecialistName } from './types.js';

export interface CapabilityDescriptor {
  id: string;
  kind: 'delivery' | 'memory' | 'protocol' | 'reminder' | 'skill' | 'utility';
  description: string;
  allowedSpecialists: SpecialistName[];
  mustUseForIntents?: string[];
}

export interface SpecialistCapabilitySummary {
  name: SpecialistName;
  responsibility: string;
  capabilityIds: string[];
}

const GENERAL_CAPABILITY_NAMES = new Set([
  'read_memory',
  'write_memory',
  'schedule_reminder',
  'list_reminders',
  'manage_reminder',
  'get_time_detail',
  'convert_time',
  'recall_history',
  'convert_calendar',
  'reverse_bazi',
  'generate_random',
  'manage_skill',
]);

function inferCapabilityKind(name: string): CapabilityDescriptor['kind'] {
  if (name.includes('memory')) return 'memory';
  if (name.includes('reminder')) return 'reminder';
  if (name === 'load_skill' || name === 'run_skill_script') return 'skill';
  if (name.startsWith('interpret_')) return 'skill';
  return 'utility';
}

function createFilteredRegistry(args: {
  baseRegistry: ToolRegistrySnapshot;
  allowedNames: Set<string>;
}): ToolRegistrySnapshot {
  const toolDefinitions = args.baseRegistry.toolDefinitions.filter((tool) =>
    args.allowedNames.has(tool.function.name),
  );
  const allowedToolNames = new Set(
    toolDefinitions.map((tool) => tool.function.name),
  );

  return {
    toolDefinitions,
    buildToolPrompts: () =>
      args.baseRegistry
        .buildToolPrompts()
        .split('\n\n')
        .filter((block) => {
          const match = /^###\s+([^\n]+)/.exec(block);
          return match ? allowedToolNames.has(match[1].trim()) : false;
        })
        .join('\n\n'),
    async executeTool(name, toolArgs, options) {
      if (!args.allowedNames.has(name)) {
        return {
          output: `当前 specialist 无权调用能力 ${name}。`,
          isError: true,
        };
      }
      return args.baseRegistry.executeTool(name, toolArgs, options);
    },
    getExecutionMode(name) {
      if (!args.allowedNames.has(name)) return 'serial';
      return args.baseRegistry.getExecutionMode(name);
    },
    getProtectedToolNames() {
      const allowed = new Set<string>();
      for (const name of args.baseRegistry.getProtectedToolNames()) {
        if (args.allowedNames.has(name)) {
          allowed.add(name);
        }
      }
      return allowed;
    },
  };
}

export interface CapabilityCatalog {
  descriptors: CapabilityDescriptor[];
  xuanxueInterpretationEnabled: boolean;
  boardSkillCatalog: Array<{
    dir: string;
    name: string;
    description: string;
    trigger: string;
    entry: string;
    parameterSignature?: string;
  }>;
  createRegistryForSpecialist(specialist: SpecialistName): ToolRegistrySnapshot;
  listSpecialists(): SpecialistCapabilitySummary[];
}

export function createCapabilityCatalog(args: {
  baseRegistry: ToolRegistrySnapshot;
  deps: AgentRuntimeDeps;
  accountId?: string;
  userId?: string;
}): Promise<CapabilityCatalog> {
  return createCapabilityCatalogInternal(args);
}

async function createCapabilityCatalogInternal(args: {
  baseRegistry: ToolRegistrySnapshot;
  deps: AgentRuntimeDeps;
  accountId?: string;
  userId?: string;
}): Promise<CapabilityCatalog> {
  // 这里按当前账号的启用状态过滤官方 skill，避免 prompt 宣称未开放的能力。
  const officialSkills = args.deps.skillCatalog.listOfficialSkillMetadata();
  const enabledSkillNames = await args.deps.skillCatalog.listEnabledSkillNames(
    args.userId,
  );
  const enabledOfficialSkills = officialSkills.filter((skill) =>
    enabledSkillNames.includes(skill.name),
  );
  const boardCompositeTools = enabledOfficialSkills
    .flatMap((skill) => {
      if (skill.entry?.type !== 'tool') return [];
      if (skill.entry.tool === 'interpret_xuanxue') return [];
      return [skill.entry.tool];
    });

  const boardCapabilityNames = new Set([
    'load_skill',
    'run_skill_script',
    'read_memory',
    'recall_history',
    'get_time_detail',
    'convert_time',
    ...boardCompositeTools,
  ]);

  const xuanxueInterpretationEnabled = true;
  const interpretCapabilityNames = new Set([
    'interpret_xuanxue',
    'list_knowledge_sections',
    'read_knowledge_section',
  ]);
  const generalCapabilityNames = new Set(GENERAL_CAPABILITY_NAMES);
  if (args.accountId?.startsWith('web:')) {
    generalCapabilityNames.delete('schedule_reminder');
    generalCapabilityNames.delete('list_reminders');
    generalCapabilityNames.delete('manage_reminder');
  }

  const allowedBySpecialist: Record<SpecialistName, Set<string>> = {
    'general-assistant': generalCapabilityNames,
    'xuanxue-board-agent': boardCapabilityNames,
    'xuanxue-interpret-agent': interpretCapabilityNames,
  };

  const definitionMap = new Map<string, ToolDefinition>(
    args.baseRegistry.toolDefinitions.map((tool) => [tool.function.name, tool]),
  );

  const allAllowedNames = new Set<string>();
  for (const names of Object.values(allowedBySpecialist)) {
    for (const name of names) {
      allAllowedNames.add(name);
    }
  }

  const descriptors = Array.from(allAllowedNames)
    .flatMap((name): CapabilityDescriptor[] => {
      const definition = definitionMap.get(name);
      if (!definition) return [];
      const allowedSpecialists = (
        Object.entries(allowedBySpecialist) as Array<[SpecialistName, Set<string>]>
      )
        .filter(([, names]) => names.has(name))
        .map(([specialist]) => specialist);
      return [
        {
          id: name,
          kind: inferCapabilityKind(name),
          description: definition.function.description,
          allowedSpecialists,
          mustUseForIntents:
            name === 'interpret_xuanxue'
              ? ['xuanxue_interpretation', 'xuanxue_followup']
              : undefined,
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const boardSkillCatalog = enabledOfficialSkills
    .filter((skill) => skill.dir !== 'xuanxue-jiedu')
    .map((skill) => ({
      dir: skill.dir,
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      entry:
        skill.entry?.type === 'tool'
          ? skill.entry.tool
          : skill.entry?.type === 'script'
            ? skill.entry.file
            : 'knowledge_only',
      parameterSignature: skill.parameters
        ? formatParamSignature(skill.parameters)
        : undefined,
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));

  return {
    descriptors,
    xuanxueInterpretationEnabled,
    boardSkillCatalog,
    createRegistryForSpecialist(specialist) {
      return createFilteredRegistry({
        baseRegistry: args.baseRegistry,
        allowedNames: allowedBySpecialist[specialist],
      });
    },
    listSpecialists() {
      const specialists: SpecialistCapabilitySummary[] = [
        {
          name: 'general-assistant',
          responsibility: '处理日常对话、提醒、记忆、时间和通用工具请求',
          capabilityIds: Array.from(allowedBySpecialist['general-assistant']).sort(),
        },
        {
          name: 'xuanxue-board-agent',
          responsibility: '只负责起卦、排盘、生成命盘或原始术数结果，不负责解释',
          capabilityIds: Array.from(allowedBySpecialist['xuanxue-board-agent']).sort(),
        },
      ];
      if (xuanxueInterpretationEnabled) {
        specialists.push({
          name: 'xuanxue-interpret-agent',
          responsibility: '只负责玄学专业解读，且必须调用 interpret_xuanxue',
          capabilityIds: Array.from(
            allowedBySpecialist['xuanxue-interpret-agent'],
          ).sort(),
        });
      }
      return specialists;
    },
  };
}
