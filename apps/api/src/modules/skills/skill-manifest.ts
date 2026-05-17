import fs from 'fs';
import path from 'path';

import { resolveOfficialSkillsDir } from '../../infrastructure/official-skills-path.js';

export type SkillParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

export interface SkillParamProperty {
  type: SkillParamType | SkillParamType[];
  description: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: { type: SkillParamType; enum?: unknown[] };
  properties?: Record<string, SkillParamProperty>;
  required?: string[];
}

export interface SkillConditionalRequirement {
  when: {
    field: string;
    equals: unknown;
  };
  required: string[];
  description?: string;
}

export interface SkillExamplePayload {
  name?: string;
  description?: string;
  value: Record<string, unknown>;
}

export interface SkillParametersSchema {
  type: 'object';
  properties: Record<string, SkillParamProperty>;
  required?: string[];
  conditionalRequired?: SkillConditionalRequirement[];
  atLeastOneOf?: string[][];
  allOrNoneOf?: string[][];
  examples?: SkillExamplePayload[];
}

export type SkillEntry =
  | {
      type: 'script';
      file: string;
    }
  | {
      type: 'tool';
      tool: string;
      fallbackScript?: string;
    };

export interface OfficialSkillCatalogEntry {
  dir: string;
  name: string;
  description: string;
  trigger: string;
  entry?: SkillEntry;
  parameters?: SkillParametersSchema;
  manifestSource: 'skill.json' | 'metadata.json';
  manifestVersion?: number;
  requiresLoad?: boolean;
}

interface SkillManifestFile {
  manifestVersion?: number;
  name?: string;
  description?: string;
  trigger?: string;
  parameters?: SkillParametersSchema;
  requiresLoad?: boolean;
  entry?:
    | { type?: 'script'; file?: string }
    | { type?: 'tool'; tool?: string; fallbackScript?: string };
}

interface LegacySkillMetadataFile {
  name?: string;
  description?: string;
  trigger?: string;
  script?: string;
  parameters?: SkillParametersSchema;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function pickParameters(
  raw: SkillManifestFile | LegacySkillMetadataFile,
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

function pickEntry(
  raw: SkillManifestFile | LegacySkillMetadataFile,
): SkillEntry | undefined {
  if ('entry' in raw && raw.entry && typeof raw.entry === 'object') {
    if (raw.entry.type === 'script' && typeof raw.entry.file === 'string') {
      return {
        type: 'script',
        file: raw.entry.file.trim(),
      };
    }
    if (raw.entry.type === 'tool' && typeof raw.entry.tool === 'string') {
      return {
        type: 'tool',
        tool: raw.entry.tool.trim(),
        fallbackScript:
          typeof raw.entry.fallbackScript === 'string'
            ? raw.entry.fallbackScript.trim()
            : undefined,
      };
    }
  }

  if ('script' in raw && typeof raw.script === 'string' && raw.script.trim()) {
    return {
      type: 'script',
      file: raw.script.trim(),
    };
  }

  return undefined;
}

function loadOfficialSkillDescriptor(
  skillDir: string,
  skillPath: string,
): OfficialSkillCatalogEntry | null {
  const manifestPath = path.join(skillPath, 'skill.json');
  if (fs.existsSync(manifestPath)) {
    const raw = readJsonFile<SkillManifestFile>(manifestPath);
    if (raw) {
      return {
        dir: skillDir,
        name:
          typeof raw.name === 'string' && raw.name.trim()
            ? raw.name.trim()
            : skillDir,
        description: typeof raw.description === 'string' ? raw.description : '',
        trigger: typeof raw.trigger === 'string' ? raw.trigger : '',
        entry: pickEntry(raw),
        parameters: pickParameters(raw),
        manifestSource: 'skill.json',
        manifestVersion:
          typeof raw.manifestVersion === 'number'
            ? raw.manifestVersion
            : undefined,
        requiresLoad:
          typeof raw.requiresLoad === 'boolean' ? raw.requiresLoad : true,
      };
    }
  }

  const metadataPath = path.join(skillPath, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  const raw = readJsonFile<LegacySkillMetadataFile>(metadataPath);
  if (!raw) {
    return null;
  }

  return {
    dir: skillDir,
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : skillDir,
    description: typeof raw.description === 'string' ? raw.description : '',
    trigger: typeof raw.trigger === 'string' ? raw.trigger : '',
    entry: pickEntry(raw),
    parameters: pickParameters(raw),
    manifestSource: 'metadata.json',
    requiresLoad: true,
  };
}

export function loadOfficialSkillCatalog(
  skillsDir: string = resolveOfficialSkillsDir(),
): OfficialSkillCatalogEntry[] {
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: OfficialSkillCatalogEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const skill = loadOfficialSkillDescriptor(
      entry.name,
      path.join(skillsDir, entry.name),
    );
    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}
