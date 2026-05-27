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
  it('exposes all official skills that remain in the catalog', () => {
    const catalog = loadOfficialSkillCatalog(OFFICIAL_SKILLS_DIR);

    const visibleSkills =
      loadUserVisibleOfficialSkillCatalog(OFFICIAL_SKILLS_DIR);

    expect(visibleSkills.every(isUserVisibleOfficialSkill)).toBe(true);
    expect(visibleSkills.map((skill) => skill.dir)).toEqual(
      catalog.map((skill) => skill.dir),
    );
  });
});
