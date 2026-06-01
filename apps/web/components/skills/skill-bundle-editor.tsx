'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  Download,
  Eye,
  FileText,
  Loader2,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';

import { useConfirm } from '@/lib/use-confirm';
import {
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
} from '@/features/skills/api';
import type {
  TextSkillBundleFile,
  UserCustomSkill,
} from '@/features/skills/api';
import {
  downloadSkillBundleZip,
  importSkillBundleFromZip,
} from '@/features/skills/skill-zip';

export type SkillBundleEditorData = {
  skill_name: string;
  files: TextSkillBundleFile[];
};

type SkillFrontmatter = {
  name: string;
  description: string;
  body: string;
};

const DEFAULT_SKILL_NAME = '我的 Skill';
const REQUIRED_FILE_PATHS = new Set(['SKILL.md']);
const ALLOWED_TEXT_FILE_EXTENSIONS = new Set([
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
const BLOCKED_FILE_SEGMENTS = new Set([
  '__MACOSX',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);
function toYamlScalar(value: string): string {
  return JSON.stringify(value);
}

function parseSkillMarkdown(content: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const metadata: Record<string, string> = {};

  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!item) continue;
      const raw = item[2].trim();
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        try {
          metadata[item[1]] = JSON.parse(raw);
        } catch {
          metadata[item[1]] = raw.slice(1, -1);
        }
      } else {
        metadata[item[1]] = raw;
      }
    }
  }

  return {
    name: metadata.name || '',
    description: metadata.description || '',
    body: match ? content.slice(match[0].length) : content,
  };
}

function serializeSkillMarkdown(frontmatter: SkillFrontmatter): string {
  return [
    '---',
    `name: ${toYamlScalar(frontmatter.name.trim() || DEFAULT_SKILL_NAME)}`,
    `description: ${toYamlScalar(frontmatter.description.trim())}`,
    '---',
    '',
    frontmatter.body.trimStart(),
  ].join('\n');
}

function createSkillMarkdown(name: string): string {
  return serializeSkillMarkdown({
    name,
    description: '',
    body: [
      `# ${name}`,
      '',
      '## 入口说明',
      '',
      '说明这个 Skill 适合什么问题、何时应该读取。',
      '',
      '## 推荐读取顺序',
      '',
      '- `index.md`',
      '- `docs/knowledge.md`',
    ].join('\n'),
  });
}

function createDefaultFiles(name = DEFAULT_SKILL_NAME): TextSkillBundleFile[] {
  return [
    {
      path: 'SKILL.md',
      content: createSkillMarkdown(name),
    },
    {
      path: 'index.md',
      content: [
        `# ${name} 文件索引`,
        '',
        '- `SKILL.md`：入口说明和读取边界',
        '- `docs/knowledge.md`：主要知识正文',
      ].join('\n'),
    },
    {
      path: 'docs/knowledge.md',
      content: [
        `# ${name} 知识正文`,
        '',
        '## 适用场景',
        '',
        '- 这里写这个 Skill 适合处理的问题。',
        '',
        '## 核心规则',
        '',
        '- 这里写判断流程、边界和示例。',
      ].join('\n'),
    },
  ];
}

export function createDefaultSkillBundleFiles(
  name = DEFAULT_SKILL_NAME,
): TextSkillBundleFile[] {
  return createDefaultFiles(name);
}

function normalizeFiles(files?: TextSkillBundleFile[]): TextSkillBundleFile[] {
  const incoming = files && files.length > 0 ? files : createDefaultFiles();
  const byPath = new Map<string, TextSkillBundleFile>();
  for (const file of incoming) {
    byPath.set(file.path, { path: file.path, content: file.content ?? '' });
  }
  if (!byPath.has('SKILL.md')) {
    byPath.set('SKILL.md', {
      path: 'SKILL.md',
      content: createSkillMarkdown(DEFAULT_SKILL_NAME),
    });
  }
  return Array.from(byPath.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function validateRelativeTextPath(rawPath: string): string {
  const value = rawPath.trim();
  if (!value) throw new Error('请输入文件路径');
  if (value.includes('\\')) throw new Error('路径不能包含反斜杠');
  if (value.startsWith('/') || value.includes('//')) throw new Error('路径格式不合法');
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.startsWith('.'),
    )
  ) {
    throw new Error('路径不能包含隐藏目录、空目录或 ..');
  }
  if (segments.some((segment) => BLOCKED_FILE_SEGMENTS.has(segment))) {
    throw new Error('路径不能包含依赖、构建产物或缓存目录');
  }
  const fileName = segments[segments.length - 1] ?? '';
  const extensionIndex = fileName.lastIndexOf('.');
  const extension =
    extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : '';
  if (!ALLOWED_TEXT_FILE_EXTENSIONS.has(extension)) {
    throw new Error('只能创建安全文本文件');
  }
  return value;
}

function MarkdownBundlePreview({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}) {
  if (!content.trim()) {
    return (
      <div
        className={`flex min-h-[360px] items-center justify-center rounded-xl border border-dashed border-hairline bg-canvas/45 px-6 py-10 text-center text-[13px] leading-relaxed text-muted ${className}`}
      >
        当前文件还没有内容。
      </div>
    );
  }

  const components: Components = {
    h1: ({ children }) => (
      <h1 className="mb-3 text-[22px] font-semibold tracking-tight text-ink">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-5 text-[17px] font-semibold tracking-tight text-ink first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-2 mt-4 text-[15px] font-semibold text-ink first:mt-0">
        {children}
      </h3>
    ),
    p: ({ children }) => (
      <p className="mb-3 whitespace-pre-wrap break-words text-[14px] leading-7 text-muted last:mb-0">
        {children}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="mb-3 list-disc space-y-1.5 pl-5 text-[14px] leading-7 text-muted">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-[14px] leading-7 text-muted">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-1">{children}</li>,
    code: ({ children, className }) => {
      const isBlock = className?.includes('language-');
      if (isBlock) return <code className={className}>{children}</code>;
      return (
        <code className="rounded-md bg-surface-card px-1.5 py-0.5 font-mono text-[12px] text-primary">
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="mb-4 overflow-x-auto rounded-xl border border-hairline bg-surface-card px-4 py-3 font-mono text-[12px] leading-relaxed text-muted">
        {children}
      </pre>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mb-4 border-l-2 border-primary/50 pl-4 text-muted">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="mb-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13px] text-muted">
          {children}
        </table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-hairline bg-surface-card px-3 py-2 text-left font-medium text-ink">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-hairline px-3 py-2">{children}</td>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {children}
      </a>
    ),
    hr: () => <hr className="my-5 border-hairline" />,
  };

  return (
    <div
      className={`min-h-[360px] overflow-auto rounded-xl border border-hairline bg-canvas/45 px-5 py-4 ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function SkillBundleEditor({
  initial,
  onSave,
}: {
  initial?: UserCustomSkill;
  onSave: (data: SkillBundleEditorData) => Promise<void>;
  onCancel?: () => void;
}) {
  const { confirm: confirmDialog } = useConfirm();
  const [files, setFiles] = useState<TextSkillBundleFile[]>(
    normalizeFiles(initial?.files),
  );
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('edit');
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [addingFile, setAddingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [pathError, setPathError] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const newFilePathInputRef = useRef<HTMLInputElement>(null);

  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0];
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  const skillDraft = useMemo(
    () => parseSkillMarkdown(skillFile?.content ?? ''),
    [skillFile?.content],
  );
  const displayName = skillDraft.name || initial?.skill_name || DEFAULT_SKILL_NAME;

  const selectedRequired = selectedFile
    ? REQUIRED_FILE_PATHS.has(selectedFile.path)
    : false;

  useEffect(() => {
    if (!fileMenuOpen) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (fileMenuRef.current?.contains(event.target as Node)) return;
      setFileMenuOpen(false);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFileMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [fileMenuOpen]);

  useEffect(() => {
    if (addingFile) newFilePathInputRef.current?.focus();
  }, [addingFile]);

  const updateFile = (path: string, content: string) => {
    setFiles((prev) =>
      prev.map((file) => (file.path === path ? { ...file, content } : file)),
    );
  };

  const updateSkillDraft = (patch: Partial<SkillFrontmatter>) => {
    const next = serializeSkillMarkdown({ ...skillDraft, ...patch });
    updateFile('SKILL.md', next);
  };

  const selectFile = (path: string) => {
    setSelectedPath(path);
    setPathError('');
    setActiveTab('edit');
    setFileMenuOpen(false);
  };

  const startAddFile = () => {
    setAddingFile(true);
    setNewFilePath('');
    setPathError('');
    setFileMenuOpen(false);
  };

  const cancelAddFile = () => {
    setAddingFile(false);
    setNewFilePath('');
    setPathError('');
  };

  const handleAddFile = (rawPath: string) => {
    setPathError('');
    try {
      const path = validateRelativeTextPath(rawPath);
      if (files.some((file) => file.path === path)) {
        setPathError('同名文件已存在');
        return false;
      }
      setError('');
      setPathError('');
      setFiles((prev) =>
        [...prev, { path, content: `# ${path.split('/').pop()?.replace(/\.md$/, '') || '新文件'}\n` }].sort(
          (left, right) => left.path.localeCompare(right.path),
        ),
      );
      setSelectedPath(path);
      setActiveTab('edit');
      setAddingFile(false);
      setNewFilePath('');
      return true;
    } catch (err) {
      setPathError(err instanceof Error ? err.message : '文件路径不合法');
      return false;
    }
  };

  const handleDeleteFile = async () => {
    if (!selectedFile || REQUIRED_FILE_PATHS.has(selectedFile.path)) {
      return;
    }
    const ok = await confirmDialog({
      title: '删除文件',
      message: `确定删除 ${selectedFile.path}？`,
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    setFiles((prev) => prev.filter((file) => file.path !== selectedFile.path));
    setSelectedPath('SKILL.md');
  };

  const handleSubmit = async () => {
    const hasSkill = files.some((file) => file.path === 'SKILL.md');
    if (!hasSkill) {
      setError('Bundle 必须包含 SKILL.md');
      return;
    }
    if (files.length > MAX_SKILL_BUNDLE_FILES) {
      setError(`Bundle 文件数不超过 ${MAX_SKILL_BUNDLE_FILES} 个`);
      return;
    }
    const oversizedFile = files.find(
      (file) => file.content.length > MAX_SKILL_BUNDLE_FILE_LENGTH,
    );
    if (oversizedFile) {
      setError(
        `${oversizedFile.path} 内容不能超过 ${MAX_SKILL_BUNDLE_FILE_LENGTH.toLocaleString()} 字`,
      );
      return;
    }
    const totalLength = files.reduce(
      (sum, file) => sum + file.content.length,
      0,
    );
    if (totalLength > MAX_SKILL_BUNDLE_TOTAL_LENGTH) {
      setError(
        `Bundle 总内容不能超过 ${MAX_SKILL_BUNDLE_TOTAL_LENGTH.toLocaleString()} 字`,
      );
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        skill_name: displayName.trim() || DEFAULT_SKILL_NAME,
        files,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleImportZip = async (file: File | undefined) => {
    if (!file) return;
    const ok = await confirmDialog({
      title: '导入 ZIP',
      message: '导入后会用压缩包内容替换当前草稿，是否继续？',
      confirmLabel: '导入',
    });
    if (!ok) return;

    setImporting(true);
    setError('');
    setPathError('');
    try {
      const imported = await importSkillBundleFromZip(file);
      setFiles(imported.files);
      setSelectedPath('SKILL.md');
      setActiveTab('edit');
      setAddingFile(false);
      setFileMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入 ZIP 失败');
    } finally {
      setImporting(false);
    }
  };

  const handleExportZip = () => {
    setError('');
    try {
      downloadSkillBundleZip(displayName, files);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出 ZIP 失败');
    }
  };

  const inputClass =
    'w-full rounded-xl border border-hairline bg-canvas px-3.5 py-3 text-[14px] leading-relaxed placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none transition-all';
  const textareaClass =
    'w-full resize-y rounded-xl border border-hairline bg-canvas px-4 py-4 font-mono text-[14px] leading-7 placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none transition-all';

  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-surface-card shadow-sm">
      <div className="space-y-3 border-b border-hairline bg-canvas/35 p-3 sm:p-4">
        <div ref={fileMenuRef} className="relative">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={fileMenuOpen}
            onClick={() => setFileMenuOpen((open) => !open)}
            className={`group flex min-h-14 w-full items-center gap-3 rounded-xl border bg-surface-card px-3.5 py-2.5 text-left shadow-sm transition-all hover:border-primary/40 hover:bg-surface-cream-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 ${
              fileMenuOpen ? 'border-primary/50 bg-surface-cream-strong' : 'border-hairline'
            }`}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline bg-canvas text-primary transition-colors group-hover:border-primary/30">
              <FileText size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-muted">
                当前文件
              </span>
              <span className="mt-0.5 block truncate font-mono text-[14px] font-semibold text-ink sm:text-[15px]">
                {selectedFile?.path ?? '未选择文件'}
              </span>
            </span>
            <span className="hidden shrink-0 rounded-md border border-hairline bg-canvas px-2 py-1 text-[11px] font-medium text-muted sm:inline-flex">
              {files.length} 个文件
            </span>
            <ChevronDown
              size={18}
              className={`shrink-0 text-muted transition-transform ${fileMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {fileMenuOpen ? (
            <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-hairline bg-surface-card shadow-xl animate-scale-in">
              <div
                role="listbox"
                aria-label="选择文件"
                className="max-h-72 space-y-1 overflow-y-auto p-1.5"
              >
                {files.map((file) => {
                  const selected = file.path === selectedFile?.path;
                  const required = REQUIRED_FILE_PATHS.has(file.path);
                  return (
                    <button
                      key={file.path}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => selectFile(file.path)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        selected
                          ? 'bg-primary/10 text-ink'
                          : 'text-muted hover:bg-surface-cream-strong hover:text-ink'
                      }`}
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                          selected
                            ? 'border-primary/30 bg-primary/10 text-primary'
                            : 'border-hairline bg-canvas text-muted'
                        }`}
                      >
                        {selected ? <Check size={15} /> : <FileText size={15} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] font-semibold">
                          {file.path}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted">
                          {required ? '核心文件' : '自定义文件'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void handleImportZip(file);
          }}
        />

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 sm:gap-3">
          <button
            type="button"
            onClick={startAddFile}
            className="inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-cream-strong sm:gap-2 sm:text-[14px]"
          >
            <Plus size={17} />
            新建
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            className="inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-cream-strong disabled:opacity-50 sm:gap-2 sm:text-[14px]"
          >
            {importing ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />}
            导入
          </button>
          <button
            type="button"
            onClick={handleExportZip}
            className="inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-cream-strong sm:gap-2 sm:text-[14px]"
          >
            <Download size={17} />
            导出
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-cream-strong disabled:opacity-50 sm:gap-2 sm:text-[14px]"
          >
            {saving ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />}
            保存
          </button>
          <button
            type="button"
            onClick={handleDeleteFile}
            disabled={selectedRequired}
            className="inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-2 text-[13px] font-semibold text-error transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 sm:gap-2 sm:text-[14px]"
            title={selectedRequired ? '核心文件不能删除' : '删除文件'}
          >
            <Trash2 size={17} />
            删除
          </button>
        </div>

        {addingFile ? (
          <form
            className="grid gap-2 rounded-xl border border-hairline bg-surface-card p-2 sm:grid-cols-[1fr_auto_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              handleAddFile(newFilePath);
            }}
          >
            <label className="sr-only" htmlFor="new-skill-bundle-file-path">
              新文件路径
            </label>
            <input
              ref={newFilePathInputRef}
              id="new-skill-bundle-file-path"
              value={newFilePath}
              onChange={(event) => setNewFilePath(event.currentTarget.value)}
              placeholder="docs/example.md"
              className="h-10 min-w-0 rounded-lg border border-hairline bg-canvas px-3 font-mono text-[13px] text-ink placeholder:text-muted/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
            />
            <button
              type="submit"
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-primary px-3 text-[13px] font-semibold text-white transition-colors hover:bg-primary/90"
            >
              <Plus size={15} />
              创建
            </button>
            <button
              type="button"
              onClick={cancelAddFile}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-hairline bg-canvas px-3 text-[13px] font-semibold text-muted transition-colors hover:text-ink"
            >
              取消
            </button>
          </form>
        ) : null}

        <div className="grid grid-cols-2 rounded-lg border border-hairline bg-surface-card">
          <button
            type="button"
            onClick={() => setActiveTab('edit')}
            aria-pressed={activeTab === 'edit'}
            className={`relative inline-flex h-12 items-center justify-center gap-2 text-[14px] font-semibold transition-colors ${
              activeTab === 'edit' ? 'text-primary' : 'text-muted hover:text-ink'
            }`}
          >
            <Code2 size={16} />
            文本编辑
            {activeTab === 'edit' ? (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" />
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('preview')}
            aria-pressed={activeTab === 'preview'}
            className={`relative inline-flex h-12 items-center justify-center gap-2 border-l border-hairline text-[14px] font-semibold transition-colors ${
              activeTab === 'preview' ? 'text-primary' : 'text-muted hover:text-ink'
            }`}
          >
            <Eye size={16} />
            预览
            {activeTab === 'preview' ? (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" />
            ) : null}
          </button>
        </div>

        {pathError ? (
          <p className="text-[12px] leading-relaxed text-red-300">
            {pathError}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-start gap-2 border-b border-red-500/20 bg-red-500/10 px-5 py-3 text-[13px] leading-relaxed text-red-200 sm:px-6">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {selectedFile ? (
        <main className="min-w-0 bg-surface-card p-3 sm:p-4 lg:p-5">
          {activeTab === 'edit' ? (
            selectedFile.path === 'SKILL.md' ? (
              <div className="space-y-4 rounded-xl border border-hairline bg-canvas/35 p-3 sm:p-4">
                <label className="block space-y-2">
                  <span className="text-[13px] font-medium text-ink">
                    name
                  </span>
                  <input
                    value={skillDraft.name}
                    onChange={(event) =>
                      updateSkillDraft({ name: event.target.value })
                    }
                    className={inputClass}
                  />
                </label>
                <label className="block space-y-2">
                  <span className="text-[13px] font-medium text-ink">
                    description
                  </span>
                  <textarea
                    value={skillDraft.description}
                    onChange={(event) =>
                      updateSkillDraft({ description: event.target.value })
                    }
                    rows={5}
                    className={`${inputClass} min-h-[132px] resize-y`}
                  />
                </label>
                <label className="block space-y-2">
                  <span className="text-[13px] font-medium text-ink">
                    入口说明 / 推荐读取顺序
                  </span>
                  <textarea
                    value={skillDraft.body}
                    onChange={(event) =>
                      updateSkillDraft({ body: event.target.value })
                    }
                    rows={18}
                    className={`${textareaClass} min-h-[460px]`}
                  />
                </label>
              </div>
            ) : (
              <textarea
                value={selectedFile.content}
                onChange={(event) =>
                  updateFile(selectedFile.path, event.target.value)
                }
                className={`${textareaClass} min-h-[680px]`}
              />
            )
          ) : (
            <MarkdownBundlePreview
              content={selectedFile.content}
              className="min-h-[680px]"
            />
          )}
        </main>
      ) : null}
    </div>
  );
}
