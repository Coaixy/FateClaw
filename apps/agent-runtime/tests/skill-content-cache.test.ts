import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareSkillContent,
  type SkillContentRevision,
} from '@fateclaw/contracts/skills/content';
import { SkillContentCache } from '#agent/skill-content-cache';

const roots: string[] = [];
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-skill-cache-'));
  roots.push(value);
  return value;
}
function revision(
  revisionId = 'revision-1',
  content = '# Skill',
): SkillContentRevision {
  return {
    skillId: 'skill-1',
    revisionId,
    ...prepareSkillContent([
      { path: 'SKILL.md', content },
      { path: 'docs/中文.md', content: '跨区域知识' },
    ]),
  };
}
afterEach(() => {
  for (const item of roots.splice(0))
    fs.rmSync(item, { recursive: true, force: true });
});

describe('skill content cache', () => {
  it('deduplicates concurrent downloads and rebuilds missing snapshots in empty deployments', async () => {
    const rev = revision();
    const cache = new SkillContentCache({ root: root() });
    const read = vi.fn(async () => rev);
    const [one, two] = await Promise.all([
      cache.acquire(rev, read),
      cache.acquire(rev, read),
    ]);
    expect(two.baseDir).toBe(one.baseDir);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      fs.readFileSync(path.join(one.baseDir, 'docs/中文.md'), 'utf8'),
    ).toBe('跨区域知识');
    one.release();
    two.release();
    fs.rmSync(one.baseDir, { recursive: true });
    const restored = await cache.acquire(rev, read);
    const other = await new SkillContentCache({ root: root() }).acquire(
      rev,
      read,
    );
    expect(restored.baseDir).not.toBe(one.baseDir);
    expect(other.baseDir).not.toBe(restored.baseDir);
    expect(read).toHaveBeenCalledTimes(3);
    restored.release();
    other.release();
  });

  it('evicts inactive content to meet capacity while retaining active revisions and repairing corruption separately', async () => {
    const cache = new SkillContentCache({ root: root(), maxBytes: 1 });
    const first = await cache.acquire(revision('old'), async () =>
      revision('old'),
    );
    const next = await cache.acquire(revision('new', '# New'), async () =>
      revision('new', '# New'),
    );
    expect(fs.existsSync(first.filePath)).toBe(true);
    fs.writeFileSync(next.filePath, 'corrupted');
    const repaired = await cache.acquire(revision('new', '# New'), async () =>
      revision('new', '# New'),
    );
    expect(repaired.baseDir).not.toBe(next.baseDir);
    expect(fs.readFileSync(repaired.filePath, 'utf8')).toBe('# New');
    next.release();
    expect(fs.existsSync(next.baseDir)).toBe(false);
    expect(fs.existsSync(first.filePath)).toBe(true);
    first.release();
    first.release();
    expect(fs.existsSync(first.baseDir)).toBe(false);
    repaired.release();
    expect(fs.existsSync(repaired.baseDir)).toBe(false);
  });

  it('expires idle snapshots while retaining leases, and retries failed downloads without publishing partial content', async () => {
    const location = root();
    let now = 0;
    const cache = new SkillContentCache({
      root: location,
      maxIdleMs: 10,
      now: () => now,
    });
    const rev = revision();
    await expect(
      cache.acquire(rev, async () => ({ ...rev, skillId: 'other-skill' })),
    ).rejects.toThrow('不一致');
    await expect(
      cache.acquire(rev, async () => ({
        ...rev,
        files: [{ path: '../escape.md', content: '' }],
      })),
    ).rejects.toThrow('路径');
    expect(fs.readdirSync(location)).toEqual([]);
    const active = await cache.acquire(rev, async () => rev);
    now = 20;
    cache.prune();
    expect(fs.existsSync(active.filePath)).toBe(true);
    active.release();
    now = 31;
    cache.prune();
    expect(fs.existsSync(active.baseDir)).toBe(false);
  });
});
