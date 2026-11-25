import type { SkillContextEntryDto } from '@fateclaw/contracts/chat';

export type { SkillContextEntryDto as SkillContextEntry } from '@fateclaw/contracts/chat';

export function parseToolContext(raw?: string | null): SkillContextEntryDto[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Historical contexts can contain primitives; renderers require non-null objects.
    return parsed.filter(
      (entry): entry is SkillContextEntryDto =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
  } catch {
    return [];
  }
}
