import { describe, expect, it } from 'vitest';

import {
  isUserVisibleOfficialSkill,
  loadUserVisibleOfficialSkillCatalog,
} from './skills-service.js';
import { listPaipanRegistry } from '../chat/paipan-registry.js';

describe('system paipan visibility', () => {
  it('exposes all registered system paipan boards', () => {
    const catalog = listPaipanRegistry();

    const visibleSkills = loadUserVisibleOfficialSkillCatalog();

    expect(visibleSkills.every(isUserVisibleOfficialSkill)).toBe(true);
    expect(visibleSkills.map((skill) => skill.dir)).toEqual(
      catalog.map((skill) => skill.dir),
    );
  });
});
