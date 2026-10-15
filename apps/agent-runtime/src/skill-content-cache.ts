import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepareSkillContent,
  SkillContentValidationError,
  SKILL_CONTENT_FORMAT_VERSION,
  type SkillContentFile,
  type SkillContentRevision,
  type SkillRevisionRef,
} from '@fateclaw/contracts/skills/content';
import { log } from './io.js';

export interface SkillSnapshot {
  baseDir: string;
  filePath: string;
  release(): void;
}

interface Entry {
  key: string;
  baseDir: string;
  bytes: number;
  lastUsed: number;
  users: number;
}

interface CacheOptions {
  root: string;
  maxBytes?: number;
  maxIdleMs?: number;
  now?: () => number;
}

const processInstance = `owner-${process.pid}-${randomUUID()}`;
const defaultCaches = new Map<string, SkillContentCache>();

function assertPrivateCacheRoot(root: string): void {
  if (
    /[\\/]\.pi[\\/](?:agent[\\/])?skills(?:[\\/]|$)/.test(path.resolve(root))
  ) {
    throw new Error('私有 Skill 不能写入 Pi 全局目录');
  }
}

function readSnapshot(baseDir: string): SkillContentFile[] | null {
  const files: SkillContentFile[] = [];
  const walk = (current: string): boolean => {
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, child.name);
      if (child.isDirectory()) {
        if (!walk(absolute)) return false;
      } else if (child.isFile()) {
        files.push({
          path: path.relative(baseDir, absolute).split(path.sep).join('/'),
          content: fs.readFileSync(absolute, 'utf8'),
        });
      } else return false;
    }
    return true;
  };
  try {
    return walk(baseDir) ? files : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class SkillContentCache {
  private readonly root: string;
  private readonly ownerRoot: string;
  private readonly maxBytes: number;
  private readonly maxIdleMs: number;
  private readonly now: () => number;
  private readonly current = new Map<string, Entry>();
  private readonly entries = new Set<Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private lastSweep = -Infinity;

  constructor(options: CacheOptions) {
    this.root = path.join(path.resolve(options.root), 'cache-v1');
    assertPrivateCacheRoot(this.root);
    this.ownerRoot = path.join(this.root, processInstance);
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxIdleMs = options.maxIdleMs ?? 7 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  async acquire(
    ref: SkillRevisionRef,
    read: () => Promise<SkillContentRevision | null>,
  ): Promise<SkillSnapshot> {
    if (ref.formatVersion !== SKILL_CONTENT_FORMAT_VERSION)
      throw new Error(`不支持的 Skill 内容格式：${ref.formatVersion}`);
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          ref.skillId,
          ref.revisionId,
          ref.formatVersion,
          ref.checksum,
        ]),
      )
      .digest('hex');
    let work = this.pending.get(key);
    if (!work) {
      work = this.load(key, ref, read);
      this.pending.set(key, work);
    }
    let entry: Entry;
    try {
      entry = await work;
      entry.users += 1;
      entry.lastUsed = this.now();
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key);
    }
    this.prune();
    let released = false;
    return {
      baseDir: entry.baseDir,
      filePath: path.join(entry.baseDir, 'SKILL.md'),
      release: () => {
        if (released) return;
        released = true;
        entry.users -= 1;
        entry.lastUsed = this.now();
        this.prune();
      },
    };
  }

  private async load(
    key: string,
    ref: SkillRevisionRef,
    read: () => Promise<SkillContentRevision | null>,
  ): Promise<Entry> {
    const cached = this.current.get(key);
    if (cached) {
      const files = readSnapshot(cached.baseDir);
      try {
        if (
          files &&
          prepareSkillContent(files, ref.formatVersion).checksum ===
            ref.checksum
        )
          return cached;
      } catch (err) {
        if (!(err instanceof SkillContentValidationError)) throw err;
      }
    }
    const revision = await read();
    if (
      !revision ||
      revision.skillId !== ref.skillId ||
      revision.revisionId !== ref.revisionId ||
      revision.formatVersion !== ref.formatVersion ||
      revision.checksum !== ref.checksum
    ) {
      throw new Error('Skill 修订不存在或与本次请求不一致');
    }
    const content = prepareSkillContent(revision.files, ref.formatVersion);
    if (
      content.checksum !== ref.checksum ||
      content.contentLength !== revision.contentLength
    ) {
      throw new Error('Skill 修订内容校验失败');
    }
    fs.mkdirSync(this.ownerRoot, { recursive: true });
    const token = randomUUID();
    const temp = path.join(this.ownerRoot, `.tmp-${token}`);
    const baseDir = path.join(this.ownerRoot, `${key}-${token}`);
    try {
      for (const file of content.files) {
        const target = path.join(temp, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content);
      }
      fs.renameSync(temp, baseDir);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    const entry = {
      key,
      baseDir,
      users: 0,
      lastUsed: this.now(),
      bytes: content.files.reduce(
        (sum, file) => sum + Buffer.byteLength(file.content, 'utf8'),
        0,
      ),
    };
    this.current.set(key, entry);
    this.entries.add(entry);
    return entry;
  }

  prune(): void {
    try {
      const now = this.now();
      let bytes = [...this.entries].reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      );
      for (const entry of [...this.entries].sort(
        (a, b) => a.lastUsed - b.lastUsed,
      )) {
        if (entry.users > 0 || this.pending.has(entry.key)) continue;
        if (
          bytes <= this.maxBytes &&
          now - entry.lastUsed < this.maxIdleMs &&
          this.current.get(entry.key) === entry
        )
          continue;
        fs.rmSync(entry.baseDir, { recursive: true, force: true });
        bytes -= entry.bytes;
        this.entries.delete(entry);
        if (this.current.get(entry.key) === entry)
          this.current.delete(entry.key);
      }
      if (now - this.lastSweep < 5 * 60 * 1000 || !fs.existsSync(this.root))
        return;
      this.lastSweep = now;
      // Each runtime owns its namespace; only dead owners can be removed by another process.
      for (const child of fs.readdirSync(this.root, { withFileTypes: true })) {
        const match = child.name.match(/^owner-(\d+)-[a-f0-9-]+$/);
        if (!child.isDirectory() || !match || child.name === processInstance)
          continue;
        try {
          process.kill(Number(match[1]), 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
            fs.rmSync(path.join(this.root, child.name), {
              recursive: true,
              force: true,
            });
          } else if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
        }
      }
    } catch (err) {
      log(
        `Skill cache maintenance failed (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
      );
    }
  }
}

export function getSkillContentCache(): SkillContentCache {
  const root = path.resolve(
    process.env.FATECLAW_TEXT_SKILLS_DIR ||
      path.join(
        process.env.FATECLAW_PROJECT_ROOT || process.cwd(),
        '.fateclaw/text-skills',
      ),
  );
  let cache = defaultCaches.get(root);
  if (!cache) {
    cache = new SkillContentCache({ root });
    defaultCaches.set(root, cache);
  }
  return cache;
}
