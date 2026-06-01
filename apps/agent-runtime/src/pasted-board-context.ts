import type {
  SkillContextEntry,
  UserPastedBoardInput,
} from './types.js';

export const USER_PASTED_BOARD_SKILL_PREFIX = 'user-pasted-board::';

export interface UserPastedBoardArtifactData extends UserPastedBoardInput {
  source: 'user_pasted_board';
}

export function buildUserPastedBoardSkillName(category: string): string {
  return `${USER_PASTED_BOARD_SKILL_PREFIX}${category}`;
}

export function isUserPastedBoardSkill(skill: string | undefined): boolean {
  return (
    typeof skill === 'string' &&
    skill.startsWith(USER_PASTED_BOARD_SKILL_PREFIX)
  );
}

export function inferCategoryFromUserPastedBoardSkill(
  skill: string | undefined,
): string | null {
  if (
    typeof skill !== 'string' ||
    !skill.startsWith(USER_PASTED_BOARD_SKILL_PREFIX)
  ) {
    return null;
  }
  const category = skill.slice(USER_PASTED_BOARD_SKILL_PREFIX.length).trim();
  return category || null;
}

export function buildUserPastedBoardSkillContext(
  pastedBoard: UserPastedBoardInput,
): SkillContextEntry {
  const skill = buildUserPastedBoardSkillName(pastedBoard.category);
  const artifactData: UserPastedBoardArtifactData = {
    ...pastedBoard,
    source: 'user_pasted_board',
  };

  return {
    skill,
    output: pastedBoard.content,
    artifactType: `skill.${skill}`,
    artifactTitle: `自贴盘面: ${pastedBoard.category}`,
    artifactData,
  };
}
