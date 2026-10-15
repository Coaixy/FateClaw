import type { SubscribedSkillSummary } from './api';

export type SkillSubscriptionGroup = {
  bundleId: string;
  bundleName: string;
  skills: SubscribedSkillSummary[];
};

export function groupSubscribedSkills(skills: SubscribedSkillSummary[]): {
  bundles: SkillSubscriptionGroup[];
  direct: SubscribedSkillSummary[];
} {
  const bundleMap = new Map<string, SkillSubscriptionGroup>();
  const direct: SubscribedSkillSummary[] = [];

  for (const skill of skills) {
    const sourceBundles = skill.source_bundles ?? [];
    if (sourceBundles.length === 0) {
      direct.push(skill);
      continue;
    }

    for (const bundle of sourceBundles) {
      const current =
        bundleMap.get(bundle.id) ??
        ({
          bundleId: bundle.id,
          bundleName: bundle.name,
          skills: [],
        } satisfies SkillSubscriptionGroup);
      current.skills.push(skill);
      bundleMap.set(bundle.id, current);
    }
  }

  return {
    bundles: Array.from(bundleMap.values()),
    direct,
  };
}
