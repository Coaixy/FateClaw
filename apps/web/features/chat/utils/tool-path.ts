function normalizeSkillDir(value: string): string {
  const withoutOwner = value.startsWith('user-') ? value.slice(5) : value;
  return withoutOwner
    .replace(
      /-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      '',
    )
    .replace(/-?[0-9a-f]{24,}$/i, '');
}

export function sanitizeToolPath(rawPath?: string): string | undefined {
  if (!rawPath) return undefined;
  const normalized = rawPath.trim().replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const skillFileIndex = parts.findLastIndex((part) => part === 'SKILL.md');
  if (skillFileIndex > 0) {
    return [
      normalizeSkillDir(parts[skillFileIndex - 1]),
      ...parts.slice(skillFileIndex),
    ].join('/');
  }
  const textSkillsIndex = parts.findIndex((part) => part === 'text-skills');
  if (textSkillsIndex >= 0 && textSkillsIndex + 2 < parts.length) {
    return [
      normalizeSkillDir(parts[textSkillsIndex + 2]),
      ...parts.slice(textSkillsIndex + 3),
    ].join('/');
  }
  if (parts.length > 2) {
    return parts.slice(-2).join('/');
  }
  return parts.join('/') || undefined;
}
