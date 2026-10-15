import path from 'path';

import type { Skill } from '@earendil-works/pi-coding-agent';

/**
 * 判断 target 是否位于 root 目录内部（含 root 自身）。
 *
 * 参数：
 * - target：待校验的绝对路径。
 * - root：授权根目录的绝对路径。
 *
 * 返回：target 在 root 内返回 true，否则 false。
 * 注意：这是 skill 读取/检索共用的核心安全边界，用于阻止 ../ 路径穿越；
 *       grep 与 read 必须共用同一份实现，避免两边边界逻辑分叉导致越权漏洞。
 */
export function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** 是否为 Markdown 文件（按扩展名判断，大小写不敏感）。 */
export function isMarkdownPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.md';
}

/** 单个授权 Skill 下、位于其 baseDir 边界内的候选路径集合。 */
export interface SkillPathCandidate<TSkill = Skill> {
  skill: TSkill;
  baseDir: string;
  /** 已去重、且确认在 baseDir 边界内的候选绝对路径，保持 [target, cwd] 顺序。 */
  candidates: string[];
}

/**
 * 把模型传入的 rawPath 解析为每个授权 Skill 下、位于其 baseDir 边界内的候选绝对路径。
 *
 * 解析规则：
 * - 绝对路径直接 resolve；
 * - 相对路径按各 skill 的 baseDir 解析；
 * - 同时兼容「按进程 cwd 解析」的写法，作为附加候选。
 *
 * 参数：
 * - rawPath：模型传入路径（调用方需先 trim 并排除空串）。
 * - skills：本轮授权可见的 Skill 列表。
 *
 * 返回：每个 skill 对应的边界内候选；candidates 为空表示该 skill 下无合法候选。
 * 注意：本函数只做「边界内」过滤，不做 stat 与文件类型判断，交由 read/grep 各自按语义处理。
 */
export function resolveSkillPathCandidates<TSkill extends { baseDir: string }>(
  rawPath: string,
  skills: TSkill[],
): SkillPathCandidate<TSkill>[] {
  const trimmed = rawPath.trim();
  const cwdCandidate = path.resolve(trimmed);
  return skills.map((skill) => {
    const baseDir = path.resolve(skill.baseDir);
    const target = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(baseDir, trimmed);
    const candidates = [...new Set([target, cwdCandidate])].filter(
      (candidate) => isPathInside(candidate, baseDir),
    );
    return { skill, baseDir, candidates };
  });
}
