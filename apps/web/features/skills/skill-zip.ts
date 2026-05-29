'use client';

import type { TextSkillBundleFile } from '@/features/skills/api';

/**
 * 从 ZIP 导入后给页面层使用的 Skill Bundle 草稿。
 */
export type ImportedSkillBundle = {
  skillName: string;
  files: TextSkillBundleFile[];
};

type ZipEntryRecord = {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  dataOffset: number;
};

const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.json',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.sh',
  '.py',
  '.txt',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.css',
  '.sql',
]);
const BLOCKED_DIRECTORY_NAMES = new Set([
  '__MACOSX',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);
const MAX_ZIP_FILE_SIZE = 8 * 1024 * 1024;
const MAX_SKILL_BUNDLE_FILES = 30;
const MAX_SKILL_BUNDLE_FILE_LENGTH = 100_000;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dateToDosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeUInt16(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt32(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function readUInt16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUInt32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function createLocalFileHeader(args: {
  nameBytes: Uint8Array;
  contentBytes: Uint8Array;
  checksum: number;
  dosTime: number;
  dosDate: number;
}): Uint8Array {
  const header = new Uint8Array(30 + args.nameBytes.length);
  writeUInt32(header, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
  writeUInt16(header, 4, 20);
  writeUInt16(header, 6, 0x0800);
  writeUInt16(header, 8, 0);
  writeUInt16(header, 10, args.dosTime);
  writeUInt16(header, 12, args.dosDate);
  writeUInt32(header, 14, args.checksum);
  writeUInt32(header, 18, args.contentBytes.length);
  writeUInt32(header, 22, args.contentBytes.length);
  writeUInt16(header, 26, args.nameBytes.length);
  writeUInt16(header, 28, 0);
  header.set(args.nameBytes, 30);
  return header;
}

function createCentralDirectoryHeader(args: {
  nameBytes: Uint8Array;
  contentBytes: Uint8Array;
  checksum: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
}): Uint8Array {
  const header = new Uint8Array(46 + args.nameBytes.length);
  writeUInt32(header, 0, ZIP_CENTRAL_DIRECTORY_SIGNATURE);
  writeUInt16(header, 4, 20);
  writeUInt16(header, 6, 20);
  writeUInt16(header, 8, 0x0800);
  writeUInt16(header, 10, 0);
  writeUInt16(header, 12, args.dosTime);
  writeUInt16(header, 14, args.dosDate);
  writeUInt32(header, 16, args.checksum);
  writeUInt32(header, 20, args.contentBytes.length);
  writeUInt32(header, 24, args.contentBytes.length);
  writeUInt16(header, 28, args.nameBytes.length);
  writeUInt16(header, 30, 0);
  writeUInt16(header, 32, 0);
  writeUInt16(header, 34, 0);
  writeUInt16(header, 36, 0);
  writeUInt32(header, 38, 0);
  writeUInt32(header, 42, args.localHeaderOffset);
  header.set(args.nameBytes, 46);
  return header;
}

function createEndOfCentralDirectory(args: {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}): Uint8Array {
  const footer = new Uint8Array(22);
  writeUInt32(footer, 0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUInt16(footer, 4, 0);
  writeUInt16(footer, 6, 0);
  writeUInt16(footer, 8, args.entryCount);
  writeUInt16(footer, 10, args.entryCount);
  writeUInt32(footer, 12, args.centralDirectorySize);
  writeUInt32(footer, 16, args.centralDirectoryOffset);
  writeUInt16(footer, 20, 0);
  return footer;
}

function toSafeDownloadName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'skill';
}

function normalizeRawZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function getPathSegments(path: string): string[] {
  return normalizeRawZipPath(path).split('/').filter(Boolean);
}

function shouldIgnoreForRootDetection(segments: string[]): boolean {
  return (
    segments.length === 0 ||
    segments.some((segment) => segment.startsWith('.')) ||
    BLOCKED_DIRECTORY_NAMES.has(segments[0] ?? '')
  );
}

function detectCommonRoot(paths: string[]): string | null {
  const candidates = paths
    .map(getPathSegments)
    .filter((segments) => !shouldIgnoreForRootDetection(segments));

  if (candidates.length === 0) return null;
  if (candidates.some((segments) => segments[0] === 'SKILL.md')) return null;

  const skillRoot = candidates.find(
    (segments) => segments.length >= 2 && segments[1] === 'SKILL.md',
  )?.[0];
  if (!skillRoot) return null;

  return candidates.every(
    (segments) => segments.length >= 2 && segments[0] === skillRoot,
  )
    ? skillRoot
    : null;
}

function stripCommonRoot(path: string, commonRoot: string | null): string {
  const normalized = normalizeRawZipPath(path);
  if (!commonRoot) return normalized;
  const segments = normalized.split('/').filter(Boolean);
  if (segments[0] === commonRoot) {
    return segments.slice(1).join('/');
  }
  return normalized;
}

function normalizeBundleTextPath(
  rawPath: string,
  commonRoot: string | null = null,
): string | null {
  const value = stripCommonRoot(rawPath, commonRoot).trim();
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes('//')) {
    return null;
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.startsWith('.'),
    )
  ) {
    return null;
  }
  if (segments.some((segment) => BLOCKED_DIRECTORY_NAMES.has(segment))) {
    return null;
  }
  const fileName = segments[segments.length - 1] ?? '';
  const extensionIndex = fileName.lastIndexOf('.');
  const extension =
    extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : '';
  if (!ALLOWED_TEXT_EXTENSIONS.has(extension)) return null;
  return value;
}

function parseSkillNameFromMarkdown(content: string, fallbackName: string): string {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1].split(/\r?\n/)) {
      const match = line.match(/^name:\s*(.*)$/);
      if (!match) continue;
      const raw = match[1].trim();
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
        } catch {
          const unquoted = raw.slice(1, -1).trim();
          if (unquoted) return unquoted;
        }
      }
      if (raw) return raw;
    }
  }

  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return title || fallbackName;
}

function parseSkillNameFromManifest(
  content: string | undefined,
): string | null {
  if (!content) return null;
  try {
    const manifest = JSON.parse(content) as { name?: unknown };
    return typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim()
      : null;
  } catch {
    return null;
  }
}

function normalizeSkillFiles(
  rawFiles: TextSkillBundleFile[],
  fallbackName: string,
): ImportedSkillBundle {
  const byPath = new Map<string, string>();

  for (const file of rawFiles) {
    const safePath = normalizeBundleTextPath(file.path);
    if (!safePath) continue;
    if (byPath.has(safePath)) throw new Error(`压缩包内存在重复文件：${safePath}`);
    if (file.content.length > MAX_SKILL_BUNDLE_FILE_LENGTH) {
      throw new Error(
        `单个文件内容不超过 ${MAX_SKILL_BUNDLE_FILE_LENGTH} 字`,
      );
    }
    byPath.set(safePath, file.content);
  }

  if (byPath.size > MAX_SKILL_BUNDLE_FILES) {
    throw new Error(`压缩包内文本文件不超过 ${MAX_SKILL_BUNDLE_FILES} 个`);
  }

  if (!byPath.has('SKILL.md')) {
    throw new Error('压缩包内必须包含 SKILL.md');
  }

  const files = Array.from(byPath.entries())
    .map(([path, content]) => ({ path, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  const manifestFile = files.find((file) => file.path === 'skill.json');
  const manifestName = parseSkillNameFromManifest(manifestFile?.content);
  return {
    skillName:
      manifestName ?? parseSkillNameFromMarkdown(skillFile?.content ?? '', fallbackName),
    files,
  };
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  throw new Error('无法识别 ZIP 文件结构');
}

function parseZipEntries(bytes: Uint8Array): ZipEntryRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readUInt16(view, endOffset + 10);
  const centralDirectoryOffset = readUInt32(view, endOffset + 16);
  const entries: ZipEntryRecord[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(view, offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('ZIP 中央目录损坏');
    }
    const flags = readUInt16(view, offset + 8);
    const compressionMethod = readUInt16(view, offset + 10);
    const compressedSize = readUInt32(view, offset + 20);
    const uncompressedSize = readUInt32(view, offset + 24);
    const fileNameLength = readUInt16(view, offset + 28);
    const extraLength = readUInt16(view, offset + 30);
    const commentLength = readUInt16(view, offset + 32);
    const localHeaderOffset = readUInt32(view, offset + 42);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + fileNameLength);
    const fileName = textDecoder.decode(nameBytes);
    offset += 46 + fileNameLength + extraLength + commentLength;
    if (fileName.endsWith('/')) continue;
    if ((flags & 0x01) !== 0) {
      throw new Error('不支持加密 ZIP');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error('只支持 store/deflate ZIP 压缩方式');
    }
    if (readUInt32(view, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error('ZIP 本地文件头损坏');
    }
    const localNameLength = readUInt16(view, localHeaderOffset + 26);
    const localExtraLength = readUInt16(view, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      path: fileName,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      dataOffset,
    });
  }

  return entries;
}

async function inflateRawDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('当前浏览器不支持解析 deflate ZIP，请导入未压缩 ZIP');
  }
  const stream = new Blob([toBlobPart(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipTextFiles(file: File): Promise<TextSkillBundleFile[]> {
  if (file.size > MAX_ZIP_FILE_SIZE) {
    throw new Error('压缩包不能超过 8MB');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = parseZipEntries(bytes);
  const commonRoot = detectCommonRoot(entries.map((entry) => entry.path));
  const files: TextSkillBundleFile[] = [];

  for (const entry of entries) {
    const safePath = normalizeBundleTextPath(entry.path, commonRoot);
    if (!safePath) continue;
    const compressed = bytes.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    const data =
      entry.compressionMethod === 0
        ? compressed
        : await inflateRawDeflate(compressed);
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`文件解压长度异常：${entry.path}`);
    }
    if (data.includes(0)) continue;
    files.push({
      path: safePath,
      content: textDecoder.decode(data),
    });
  }

  return files;
}

/**
 * 从用户上传的 ZIP 中解析 FateClaw 文本 Skill 包。
 *
 * 会保留压缩包里的安全 UTF-8 文本文件；二进制、隐藏目录和依赖产物会被跳过。
 */
export async function importSkillBundleFromZip(
  file: File,
): Promise<ImportedSkillBundle> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new Error('请上传 .zip 压缩包');
  }
  const fallbackName = file.name.replace(/\.zip$/i, '') || '导入 Skill';
  return normalizeSkillFiles(await readZipTextFiles(file), fallbackName);
}

/**
 * 将当前编辑器内的文本文件打包为标准 ZIP Blob。
 *
 * 为了避免额外依赖，这里写入 store 模式 ZIP；系统解压工具和后续导入流程都能正常读取。
 */
export function createSkillBundleZipBlob(files: TextSkillBundleFile[]): Blob {
  const normalized = normalizeSkillFiles(files, 'Skill');
  const now = dateToDosTime(new Date());
  const fileChunks: Uint8Array[] = [];
  const centralDirectoryChunks: Uint8Array[] = [];
  let offset = 0;

  for (const file of normalized.files) {
    const nameBytes = textEncoder.encode(file.path);
    const contentBytes = textEncoder.encode(file.content);
    const checksum = crc32(contentBytes);
    const localHeader = createLocalFileHeader({
      nameBytes,
      contentBytes,
      checksum,
      dosTime: now.time,
      dosDate: now.date,
    });
    const centralDirectoryHeader = createCentralDirectoryHeader({
      nameBytes,
      contentBytes,
      checksum,
      localHeaderOffset: offset,
      dosTime: now.time,
      dosDate: now.date,
    });
    fileChunks.push(localHeader, contentBytes);
    centralDirectoryChunks.push(centralDirectoryHeader);
    offset += localHeader.length + contentBytes.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = concatBytes(centralDirectoryChunks);
  const footer = createEndOfCentralDirectory({
    entryCount: normalized.files.length,
    centralDirectorySize: centralDirectory.length,
    centralDirectoryOffset,
  });

  return new Blob([...fileChunks, centralDirectory, footer].map(toBlobPart), {
    type: 'application/zip',
  });
}

/**
 * 触发浏览器下载当前 Skill Bundle 的 ZIP 文件。
 *
 * 文件名会根据 Skill 名称做简单清理，避免生成空文件名或路径片段。
 */
export function downloadSkillBundleZip(
  skillName: string,
  files: TextSkillBundleFile[],
): void {
  const blob = createSkillBundleZipBlob(files);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${toSafeDownloadName(skillName)}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
