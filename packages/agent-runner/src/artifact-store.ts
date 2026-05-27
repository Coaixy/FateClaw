import type { Artifact } from './types.js';
import type { RequestScope } from './request-scope.js';

export function appendArtifact(
  scope: RequestScope,
  artifact: Artifact,
): Artifact {
  scope.artifacts.push(artifact);
  return artifact;
}

export function listArtifacts(scope: RequestScope): Artifact[] {
  return [...scope.artifacts];
}

export function latestArtifactByTypeSuffix(
  scope: RequestScope,
  suffix: string,
): Artifact | null {
  for (let i = scope.artifacts.length - 1; i >= 0; i--) {
    const artifact = scope.artifacts[i];
    if (artifact.type.endsWith(suffix)) {
      return artifact;
    }
  }
  return null;
}

/**
 * 倒序扫描本次请求的 artifact，返回最近一条满足以下条件的：
 * - `type` 以 `skill.` 开头（即 skill 调用产出的 artifact）
 * - `producer` 不在 `excludeSkills` 列表里
 *
 * 主要用于玄学解读准备工具获取"本次请求中上一个起卦/排盘 skill 的原始数据"，
 * 通过 excludeSkills 跳过自身产出的 xuanxue-jiedu artifact。
 */
export function latestSkillArtifactExcluding(
  scope: RequestScope,
  excludeSkills: string[],
): Artifact | null {
  const excluded = new Set(excludeSkills);
  for (let i = scope.artifacts.length - 1; i >= 0; i--) {
    const artifact = scope.artifacts[i];
    if (!artifact.type.startsWith('skill.')) continue;
    if (excluded.has(artifact.producer)) continue;
    return artifact;
  }
  return null;
}
