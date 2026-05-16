import fs from 'fs';
import path from 'path';

import type {
  SkillManifest,
  SkillEntry,
  SkillMetadata,
  SkillParametersSchema,
} from './types.js';

const SKILL_MANIFEST_FILE = 'skill.json';

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function loadSkillManifest(skillPath: string): SkillManifest | null {
  const manifestPath = path.join(skillPath, SKILL_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return readJsonFile<SkillManifest>(manifestPath);
}

function pickParameters(
  raw: SkillManifest,
): SkillParametersSchema | undefined {
  const parameters = raw.parameters;
  if (
    parameters?.type === 'object' &&
    parameters.properties &&
    typeof parameters.properties === 'object'
  ) {
    return parameters;
  }
  return undefined;
}

function pickEntry(raw: SkillManifest): SkillEntry | undefined {
  const entry = raw.entry;
  if (!entry || typeof entry !== 'object') return undefined;

  if (entry.type === 'script' && typeof entry.file === 'string') {
    return {
      type: 'script',
      file: entry.file.trim(),
    };
  }
  if (entry.type === 'tool' && typeof entry.tool === 'string') {
    return {
      type: 'tool',
      tool: entry.tool.trim(),
      fallbackScript:
        typeof entry.fallbackScript === 'string'
          ? entry.fallbackScript.trim()
          : undefined,
    };
  }
  return undefined;
}

export function loadOfficialSkillMetadata(
  skillDir: string,
  skillPath: string,
  skillScripts: string[],
): SkillMetadata | null {
  const raw = loadSkillManifest(skillPath);
  if (!raw) {
    return null;
  }

  const name =
    typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : skillDir;
  const description =
    typeof raw.description === 'string' ? raw.description : '';
  const trigger = typeof raw.trigger === 'string' ? raw.trigger : '';
  const manifestVersion =
    typeof raw.manifestVersion === 'number' ? raw.manifestVersion : undefined;

  return {
    dir: skillDir,
    name,
    description,
    trigger,
    entry: pickEntry(raw),
    parameters: pickParameters(raw),
    type: 'official',
    manifestSource: 'skill.json',
    manifestVersion,
    requiresLoad:
      typeof raw.requiresLoad === 'boolean' ? raw.requiresLoad : true,
  };
}
