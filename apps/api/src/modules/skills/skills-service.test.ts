import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isUserVisibleOfficialSkill,
  loadUserVisibleOfficialSkillCatalog,
} from './skills-service.js';
import { loadOfficialSkillCatalog } from './skill-manifest.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_SKILLS_DIR = path.resolve(
  TEST_DIR,
  '../../../../../skills/official',
);

describe('official skill visibility', () => {
  it('keeps xuanxue-jiedu available internally but hides it from user-facing lists', () => {
    const catalog = loadOfficialSkillCatalog(OFFICIAL_SKILLS_DIR);

    expect(catalog.some((skill) => skill.dir === 'xuanxue-jiedu')).toBe(true);
    expect(catalog.find((skill) => skill.dir === 'xuanxue-jiedu')?.name).toBe(
      '通枢解读',
    );

    const visibleSkills =
      loadUserVisibleOfficialSkillCatalog(OFFICIAL_SKILLS_DIR);

    expect(visibleSkills.every(isUserVisibleOfficialSkill)).toBe(true);
    expect(visibleSkills.some((skill) => skill.dir === 'xuanxue-jiedu')).toBe(
      false,
    );
  });
});
