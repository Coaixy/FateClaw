import type {
  PaipanCatalogItemDto,
  SkillContextEntryDto,
} from '@fateclaw/contracts/chat';

import { getResolvedEnabledOfficialSkillNames } from '../../infrastructure/db.js';
import { resolveOfficialSkillsDir } from '../../infrastructure/official-skills-path.js';
import { dispatchPiPaipan } from '../../runtime/resident-agent.js';
import {
  loadOfficialSkillCatalog,
  type OfficialSkillCatalogEntry,
} from '../skills/skill-manifest.js';

const SKILLS_DIR = resolveOfficialSkillsDir();
const PAIPAN_SKILL_DIRS = new Set([
  'bazi-paipan',
  'ziwei-paipan',
  'iching-paipan',
  'jingzhan-paipan',
  'qimen-paipan',
]);

export class DirectPaipanError extends Error {
  constructor(
    public code:
      | 'PAIPAN.SKILL_NOT_FOUND'
      | 'PAIPAN.SKILL_NOT_ENABLED'
      | 'PAIPAN.SKILL_UNSUPPORTED'
      | 'PAIPAN.PARAM_INVALID'
      | 'PAIPAN.EXECUTION_FAILED',
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

function getPaipanSkillCatalogEntry(
  skillDir: string,
  officialSkills: OfficialSkillCatalogEntry[],
): OfficialSkillCatalogEntry | undefined {
  return officialSkills.find((skill) => skill.dir === skillDir);
}

async function loadAvailablePaipanSkillCatalog(
  userId: string,
): Promise<OfficialSkillCatalogEntry[]> {
  const enabledSkillNames = new Set(
    await getResolvedEnabledOfficialSkillNames(userId),
  );
  return loadOfficialSkillCatalog(SKILLS_DIR).filter(
    (skill) =>
      PAIPAN_SKILL_DIRS.has(skill.dir) &&
      skill.entry?.type === 'script' &&
      enabledSkillNames.has(skill.name),
  );
}

export function isDirectPaipanSkill(skillDir: string): boolean {
  return PAIPAN_SKILL_DIRS.has(skillDir);
}

export async function listDirectPaipanCatalog(
  userId: string,
): Promise<PaipanCatalogItemDto[]> {
  const skills = await loadAvailablePaipanSkillCatalog(userId);
  return skills.map((skill) => ({
    skill: skill.dir,
    name: skill.name,
    description: skill.description,
    parameters: skill.parameters,
    examples: skill.parameters?.examples,
  }));
}

export async function resolveDirectPaipanSkillOrThrow(args: {
  userId: string;
  skillDir: string;
}): Promise<OfficialSkillCatalogEntry> {
  if (!isDirectPaipanSkill(args.skillDir)) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      '当前只支持官方排盘类 Skill 的纯排盘直出',
      400,
    );
  }

  const skills = await loadAvailablePaipanSkillCatalog(args.userId);
  const skill = getPaipanSkillCatalogEntry(args.skillDir, skills);
  if (skill) {
    return skill;
  }

  const officialSkill = getPaipanSkillCatalogEntry(
    args.skillDir,
    loadOfficialSkillCatalog(SKILLS_DIR),
  );
  if (!officialSkill) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_NOT_FOUND',
      `未找到排盘 Skill "${args.skillDir}"`,
      404,
    );
  }

  throw new DirectPaipanError(
    'PAIPAN.SKILL_NOT_ENABLED',
    `Skill "${officialSkill.name}" 当前未启用`,
    403,
  );
}

function parseArtifactPayload(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new DirectPaipanError(
      'PAIPAN.EXECUTION_FAILED',
      '排盘脚本返回了无法解析的结果',
      500,
    );
  }
}

function mapPiPaipanFailure(args: {
  publicReasonCode?: string;
  publicErrorText?: string;
  error?: string;
  text?: string;
}): DirectPaipanError {
  const message =
    args.publicErrorText ||
    args.error ||
    args.text ||
    '排盘服务暂时不可用，请稍后重试';

  switch (args.publicReasonCode) {
    case 'paipan_param_invalid':
      return new DirectPaipanError('PAIPAN.PARAM_INVALID', message, 400);
    case 'paipan_skill_not_enabled':
      return new DirectPaipanError('PAIPAN.SKILL_NOT_ENABLED', message, 403);
    case 'paipan_skill_not_found':
      return new DirectPaipanError('PAIPAN.SKILL_NOT_FOUND', message, 404);
    default:
      return new DirectPaipanError('PAIPAN.EXECUTION_FAILED', message, 500);
  }
}

export async function executeDirectPaipan(args: {
  accountId: string;
  userId: string;
  skillDir: string;
  input: Record<string, unknown>;
  displayNote?: string;
}): Promise<{
  skill: OfficialSkillCatalogEntry;
  requestSummary: string;
  sessionTitle: string;
  skillContextEntry: SkillContextEntryDto;
}> {
  const skill = await resolveDirectPaipanSkillOrThrow({
    userId: args.userId,
    skillDir: args.skillDir,
  });
  const title = args.displayNote
    ? `${skill.name} · ${args.displayNote}`
    : skill.name;

  const result = await dispatchPiPaipan({
    accountId: args.accountId,
    userId: args.userId,
    skillDir: skill.dir,
    skillInput: args.input,
    displayTitle: title,
  });

  if (result.status !== 'success') {
    throw mapPiPaipanFailure({
      publicReasonCode: result.publicReasonCode,
      publicErrorText: result.publicErrorText,
      error: result.error,
      text: result.text,
    });
  }

  const skillContextEntry = result.skillContext?.find(
    (entry) => entry.skill === skill.dir,
  );
  if (!skillContextEntry) {
    throw new DirectPaipanError(
      'PAIPAN.EXECUTION_FAILED',
      '排盘服务未返回盘面结果',
      500,
    );
  }

  return {
    skill,
    requestSummary: title,
    sessionTitle: title,
    skillContextEntry: {
      skill: skillContextEntry.skill,
      output: skillContextEntry.output,
      artifactType: skillContextEntry.artifactType ?? `skill.${skill.dir}`,
      artifactTitle: title,
      artifactData:
        skillContextEntry.artifactData ??
        parseArtifactPayload(skillContextEntry.output),
    },
  };
}
