import {
  LIST_SECTIONS_TOOL,
  READ_SECTION_TOOL,
} from '../tools/skill/xuanxue-knowledge.js';
import type { ToolDefinition, ToolExecutionMode } from '../types.js';

export type PiKnowledgeToolName =
  | 'list_knowledge_sections'
  | 'read_knowledge_section';

const PI_KNOWLEDGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  LIST_SECTIONS_TOOL,
  READ_SECTION_TOOL,
];

const PI_KNOWLEDGE_TOOL_NAMES = new Set(
  PI_KNOWLEDGE_TOOL_DEFINITIONS.map((definition) => definition.function.name),
);

export function isPiKnowledgeToolName(
  name: string,
): name is PiKnowledgeToolName {
  return PI_KNOWLEDGE_TOOL_NAMES.has(name);
}

export function listPiKnowledgeToolDefinitions(): ToolDefinition[] {
  return [...PI_KNOWLEDGE_TOOL_DEFINITIONS];
}

export function getPiKnowledgeToolExecutionMode(
  name: string,
): ToolExecutionMode | undefined {
  return isPiKnowledgeToolName(name) ? 'serial' : undefined;
}

