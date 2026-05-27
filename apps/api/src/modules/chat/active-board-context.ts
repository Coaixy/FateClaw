import type { SkillContextEntryDto } from '@fateclaw/contracts/chat';

import { isDirectPaipanSkill } from './paipan-runtime.js';

export interface ActiveBoardContextDto extends SkillContextEntryDto {
  sourceMessageId: string;
}

interface BoardMessageLike {
  id: string;
  tool_context?: string | null;
}

export function parseStoredSkillContext(
  raw?: string | null,
): SkillContextEntryDto[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry.skill !== 'string' || typeof entry.output !== 'string') {
        return [];
      }
      return [
        {
          skill: entry.skill,
          output: entry.output,
          artifactType:
            typeof entry.artifactType === 'string'
              ? entry.artifactType
              : undefined,
          artifactTitle:
            typeof entry.artifactTitle === 'string'
              ? entry.artifactTitle
              : undefined,
          artifactData: entry.artifactData,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function extractDirectBoardEntries(
  rawToolContext?: string | null,
): SkillContextEntryDto[] {
  return parseStoredSkillContext(rawToolContext).filter((entry) =>
    isDirectPaipanSkill(entry.skill),
  );
}

export function buildActiveBoardContext(
  message: BoardMessageLike,
): ActiveBoardContextDto | null {
  const boardEntry = extractDirectBoardEntries(message.tool_context)[0];
  if (!boardEntry) return null;

  return {
    sourceMessageId: message.id,
    ...boardEntry,
  };
}
