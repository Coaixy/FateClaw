'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import {
  AlertCircle,
  Check,
  Code2,
  Download,
  Eye,
  FilePlus2,
  FileText,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { SKILL_CATEGORIES } from '@fateclaw/contracts/skills';

import { useConfirm } from '@/lib/use-confirm';
import { DEFAULT_SKILL_BUNDLE_LIMITS, skillsApi } from '@/features/skills/api';
import type {
  TextSkillBundleFile,
  UserCustomSkill,
} from '@/features/skills/api';
import {
  downloadSkillBundleZip,
  importSkillBundleFromZip,
} from '@/features/skills/skill-zip';
import { SkillFileExplorer } from './skill-file-explorer';
import { SkillTextEditor } from './skill-text-editor';

export type SkillBundleEditorData = {
  skill_name: string;
  files: TextSkillBundleFile[];
  /** 作者选定的分类；取值见 contracts 的 SKILL_CATEGORIES。 */
  category: string;
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

function canonicalizeRootBundlePath(path: string): string {
  if (path.includes('/')) return path;
  const lower = path.toLowerCase();
  if (lower === 'skill.md') return 'SKILL.md';
  if (lower === 'skill.json') return 'skill.json';
  if (lower === 'index.md') return 'index.md';
  return path;
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
    const path = canonicalizeRootBundlePath(file.path);
    byPath.set(path, { path, content: file.content ?? '' });
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
  if (value.startsWith('/') || value.includes('//'))
    throw new Error('路径格式不合法');
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.'),
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
  return canonicalizeRootBundlePath(value);
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
        className={`flex h-full items-center justify-center bg-surface-raised px-6 py-10 text-center text-[13px] leading-relaxed text-muted ${className}`}
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
      className={`h-full overflow-auto bg-surface-raised px-6 py-5 ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

type EditorState = {
  files: TextSkillBundleFile[];
  selectedPath: string;
  activeTab: 'edit' | 'preview';
  collapsedFolders: Set<string>;
  fileAction: 'create' | 'rename' | null;
  draftPath: string;
  pathError: string;
};

type EditorAction =
  | { type: 'toggleFolder'; path: string }
  | { type: 'updateFileContent'; path: string; content: string }
  | { type: 'selectFile'; path: string }
  | { type: 'startFileAction'; action: 'create' | 'rename' }
  | { type: 'cancelFileAction' }
  | { type: 'setDraftPath'; value: string }
  | { type: 'setPathError'; message: string }
  | { type: 'addFile'; path: string }
  | { type: 'renameFile'; path: string; nextPath: string }
  | { type: 'removeFile'; path: string }
  | { type: 'setActiveTab'; tab: 'edit' | 'preview' }
  | { type: 'importFiles'; files: TextSkillBundleFile[] };

function createInitialEditorState(initial?: UserCustomSkill): EditorState {
  return {
    files: normalizeFiles(initial?.files),
    selectedPath: 'SKILL.md',
    activeTab: 'edit',
    collapsedFolders: new Set(),
    fileAction: null,
    draftPath: '',
    pathError: '',
  };
}

function revealFile(collapsedFolders: Set<string>, path: string): Set<string> {
  const next = new Set(collapsedFolders);
  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    next.delete(segments.slice(0, index).join('/'));
  }
  return next;
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'toggleFolder': {
      const collapsedFolders = new Set(state.collapsedFolders);
      if (collapsedFolders.has(action.path))
        collapsedFolders.delete(action.path);
      else collapsedFolders.add(action.path);
      return { ...state, collapsedFolders };
    }
    case 'updateFileContent':
      return {
        ...state,
        files: state.files.map((file) =>
          file.path === action.path
            ? { ...file, content: action.content }
            : file,
        ),
      };
    case 'selectFile':
      return {
        ...state,
        selectedPath: action.path,
        pathError: '',
        activeTab: 'edit',
        fileAction: null,
        draftPath: '',
        collapsedFolders: revealFile(state.collapsedFolders, action.path),
      };
    case 'startFileAction':
      return {
        ...state,
        fileAction: action.action,
        draftPath: action.action === 'rename' ? state.selectedPath : '',
        pathError: '',
      };
    case 'cancelFileAction':
      return { ...state, fileAction: null, draftPath: '', pathError: '' };
    case 'setDraftPath':
      return { ...state, draftPath: action.value };
    case 'setPathError':
      return { ...state, pathError: action.message };
    case 'addFile': {
      const fileName =
        action.path
          .split('/')
          .pop()
          ?.replace(/\.mdx?$/i, '') || '新文件';
      return {
        ...state,
        pathError: '',
        files: [
          ...state.files,
          {
            path: action.path,
            content: /\.mdx?$/i.test(action.path) ? `# ${fileName}\n` : '',
          },
        ].sort((left, right) => left.path.localeCompare(right.path)),
        selectedPath: action.path,
        activeTab: 'edit',
        fileAction: null,
        draftPath: '',
        collapsedFolders: revealFile(state.collapsedFolders, action.path),
      };
    }
    case 'renameFile':
      return {
        ...state,
        files: state.files
          .map((file) =>
            file.path === action.path
              ? { ...file, path: action.nextPath }
              : file,
          )
          .sort((left, right) => left.path.localeCompare(right.path)),
        selectedPath: action.nextPath,
        fileAction: null,
        draftPath: '',
        pathError: '',
        collapsedFolders: revealFile(state.collapsedFolders, action.nextPath),
      };
    case 'removeFile':
      return {
        ...state,
        files: state.files.filter((file) => file.path !== action.path),
        selectedPath: 'SKILL.md',
        activeTab: 'edit',
        fileAction: null,
        pathError: '',
      };
    case 'setActiveTab':
      return { ...state, activeTab: action.tab };
    case 'importFiles':
      return {
        ...state,
        files: action.files,
        selectedPath: 'SKILL.md',
        activeTab: 'edit',
        fileAction: null,
        draftPath: '',
        pathError: '',
        collapsedFolders: new Set(),
      };
    default:
      return state;
  }
}

export function SkillBundleEditor({
  initial,
  onSave,
}: {
  initial?: UserCustomSkill;
  onSave: (data: SkillBundleEditorData) => Promise<void>;
}) {
  const { confirm: confirmDialog } = useConfirm();
  const [editor, dispatchEditor] = useReducer(
    editorReducer,
    initial,
    createInitialEditorState,
  );
  const {
    files,
    selectedPath,
    activeTab,
    collapsedFolders,
    fileAction,
    draftPath,
    pathError,
  } = editor;
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [error, setError] = useState('');
  // bundle 体积上限：仅在保存/导入/导出等事件处理里读取做校验，不参与渲染，
  // 因此用 ref 持有；异步拉取到的最新值随取随用，不触发无谓重渲染。
  const limitsRef = useRef(DEFAULT_SKILL_BUNDLE_LIMITS);
  // 作者选定的分类：空串是「自动归类」sentinel（交后端按内容判断），
  // 编辑态回填技能已存的分类，新建态默认自动。显式选某分类（含 '通用'）才算覆盖。
  const [category, setCategory] = useState(initial?.category ?? '');
  const [savedDraft, setSavedDraft] = useState(() =>
    initial?.id ? { files, category: initial.category ?? '' } : null,
  );
  const importInputRef = useRef<HTMLInputElement>(null);
  const filePathInputRef = useRef<HTMLInputElement>(null);

  const selectedFile =
    files.find((file) => file.path === selectedPath) ?? files[0];
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  const skillDraft = useMemo(
    () => parseSkillMarkdown(skillFile?.content ?? ''),
    [skillFile?.content],
  );
  const displayName =
    skillDraft.name || initial?.skill_name || DEFAULT_SKILL_NAME;
  const savedContents = useMemo(
    () => new Map(savedDraft?.files.map((file) => [file.path, file.content])),
    [savedDraft],
  );
  const dirtyPaths = useMemo(
    () =>
      new Set(
        files
          .filter((file) => savedContents.get(file.path) !== file.content)
          .map((file) => file.path),
      ),
    [files, savedContents],
  );
  const hasChanges =
    !savedDraft ||
    dirtyPaths.size > 0 ||
    files.length !== savedDraft.files.length ||
    category !== savedDraft.category;
  const busy = saving || importing;
  const isMarkdown = selectedFile ? /\.mdx?$/i.test(selectedFile.path) : false;

  const selectedRequired = selectedFile
    ? REQUIRED_FILE_PATHS.has(selectedFile.path)
    : false;

  useEffect(() => {
    if (fileAction) {
      filePathInputRef.current?.focus();
      filePathInputRef.current?.select();
    }
  }, [fileAction]);

  useEffect(() => {
    let cancelled = false;
    skillsApi
      .limits()
      .then((nextLimits) => {
        if (!cancelled) limitsRef.current = nextLimits;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const updateFile = (path: string, content: string) => {
    dispatchEditor({ type: 'updateFileContent', path, content });
  };

  const selectFile = (path: string) => {
    dispatchEditor({ type: 'selectFile', path });
    setMobileExplorerOpen(false);
  };

  const handleFilePath = () => {
    if (busy || !fileAction) return;
    dispatchEditor({ type: 'setPathError', message: '' });
    try {
      const path = validateRelativeTextPath(draftPath);
      if (fileAction === 'rename' && selectedRequired) return;
      const otherFiles = files.filter(
        (file) => fileAction !== 'rename' || file.path !== selectedPath,
      );
      if (otherFiles.some((file) => file.path === path)) {
        throw new Error('同名文件已存在');
      }
      if (
        otherFiles.some(
          (file) =>
            file.path.startsWith(`${path}/`) ||
            path.startsWith(`${file.path}/`),
        )
      ) {
        throw new Error('文件路径与已有文件或目录冲突');
      }
      setError('');
      dispatchEditor(
        fileAction === 'rename'
          ? { type: 'renameFile', path: selectedPath, nextPath: path }
          : { type: 'addFile', path },
      );
    } catch (err) {
      dispatchEditor({
        type: 'setPathError',
        message: err instanceof Error ? err.message : '文件路径不合法',
      });
    }
  };

  const handleDeleteFile = async () => {
    if (busy || !selectedFile || REQUIRED_FILE_PATHS.has(selectedFile.path)) {
      return;
    }
    const ok = await confirmDialog({
      title: '删除文件',
      message: `确定删除 ${selectedFile.path}？`,
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    dispatchEditor({ type: 'removeFile', path: selectedFile.path });
  };

  const handleSubmit = async () => {
    if (busy) return;
    const limits = limitsRef.current;
    const hasSkill = files.some((file) => file.path === 'SKILL.md');
    if (!hasSkill) {
      setError('Bundle 必须包含 SKILL.md');
      return;
    }
    if (files.length > limits.max_files) {
      setError(`Bundle 文件数不超过 ${limits.max_files} 个`);
      return;
    }
    const oversizedFile = files.find(
      (file) => file.content.length > limits.max_file_chars,
    );
    if (oversizedFile) {
      setError(
        `${oversizedFile.path} 内容不能超过 ${limits.max_file_chars.toLocaleString()} 字`,
      );
      return;
    }
    const totalLength = files.reduce(
      (sum, file) => sum + file.content.length,
      0,
    );
    if (totalLength > limits.max_total_chars) {
      setError(
        `Bundle 总内容不能超过 ${limits.max_total_chars.toLocaleString()} 字`,
      );
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        skill_name: displayName.trim() || DEFAULT_SKILL_NAME,
        files,
        category,
      });
      setSavedDraft({ files, category });
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleImportZip = async (file: File | undefined) => {
    if (!file || busy) return;
    const ok = await confirmDialog({
      title: '导入 ZIP',
      message: '导入后会用压缩包内容替换当前草稿，是否继续？',
      confirmLabel: '导入',
    });
    if (!ok) return;

    setImporting(true);
    setError('');
    dispatchEditor({ type: 'setPathError', message: '' });
    try {
      const imported = await importSkillBundleFromZip(file, limitsRef.current);
      dispatchEditor({ type: 'importFiles', files: imported.files });
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入 ZIP 失败');
    } finally {
      setImporting(false);
    }
  };

  const handleExportZip = () => {
    setError('');
    try {
      downloadSkillBundleZip(displayName, files, limitsRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出 ZIP 失败');
    }
  };

  const actionClass =
    'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted transition-colors hover:bg-surface-cream-strong/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40';
  const fileActionClass =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-cream-strong/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-35';

  return (
    <div
      aria-label="Skill 文件编辑器"
      aria-busy={busy}
      className="flex h-[calc(100dvh-11rem)] min-h-[540px] flex-col overflow-hidden rounded-xl border border-hairline bg-surface-raised shadow-sm"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault();
          if (!event.repeat) void handleSubmit();
        }
        if (event.key === 'Escape') {
          dispatchEditor({ type: 'cancelFileAction' });
          setMobileExplorerOpen(false);
        }
      }}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-hairline bg-canvas/70 px-3 sm:px-4">
        <Code2
          size={18}
          strokeWidth={1.6}
          className="hidden shrink-0 text-primary sm:block"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-semibold text-ink">
            {displayName}
          </h1>
          <p
            className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted"
            role="status"
          >
            {hasChanges ? (
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            ) : (
              <Check size={11} />
            )}
            {saving ? '正在保存…' : hasChanges ? '未保存' : '已保存'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={busy}
            aria-label="导入 ZIP"
            title="导入 ZIP"
            className={actionClass}
          >
            {importing ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Upload size={15} />
            )}
            <span className="hidden sm:inline">导入</span>
          </button>
          <button
            type="button"
            onClick={handleExportZip}
            disabled={busy}
            aria-label="导出 ZIP"
            title="导出 ZIP"
            className={actionClass}
          >
            <Download size={15} />
            <span className="hidden sm:inline">导出</span>
          </button>
          <span className="mx-1 h-4 w-px bg-hairline" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy}
            title="保存全部文件（Ctrl / ⌘ S）"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md btn-tactile-primary px-3 text-[12px] font-semibold text-on-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            {saving ? '保存中' : '保存'}
          </button>
        </div>
      </header>

      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        disabled={busy}
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          void handleImportZip(file);
        }}
      />

      {error ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-error/20 bg-error/10 px-4 py-3 text-[12px] leading-relaxed text-error"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        {mobileExplorerOpen ? (
          <button
            type="button"
            aria-label="关闭文件导航"
            onClick={() => setMobileExplorerOpen(false)}
            className="absolute inset-0 z-10 bg-ink/20 md:hidden"
          />
        ) : null}

        <aside
          aria-label="文件导航"
          className={[
            mobileExplorerOpen
              ? 'absolute inset-y-0 left-0 z-20 flex shadow-xl'
              : 'hidden',
            'w-60 max-w-[85%] shrink-0 flex-col border-r border-hairline bg-canvas md:static md:z-auto md:flex md:w-52 md:shadow-none lg:w-60',
          ].join(' ')}
        >
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-hairline/70 px-3">
            <h2 className="flex items-center gap-2 text-[11px] font-semibold text-muted">
              文件
              <span className="font-normal tabular-nums text-muted/70">
                {files.length}
              </span>
            </h2>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => {
                  dispatchEditor({ type: 'startFileAction', action: 'create' });
                  setMobileExplorerOpen(false);
                }}
                disabled={busy}
                aria-label="新建文件"
                title="新建文件"
                className={fileActionClass}
              >
                <FilePlus2 size={15} />
              </button>
              <button
                type="button"
                onClick={() => setMobileExplorerOpen(false)}
                aria-label="收起文件导航"
                className={fileActionClass + ' md:hidden'}
              >
                <PanelLeftClose size={15} />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <SkillFileExplorer
              files={files}
              selectedPath={selectedPath}
              collapsedFolders={collapsedFolders}
              dirtyPaths={dirtyPaths}
              onSelect={selectFile}
              onToggleFolder={(path) =>
                dispatchEditor({ type: 'toggleFolder', path })
              }
            />
          </div>
          <div className="shrink-0 space-y-2 border-t border-hairline p-3">
            <label
              htmlFor="skill-editor-category"
              className="text-[10px] font-medium text-muted"
            >
              技能分类
            </label>
            <select
              id="skill-editor-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={busy}
              title="用于技能市场的分类检索"
              className="h-8 w-full rounded-md border border-hairline bg-surface-raised px-2 text-[11px] text-body outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-50"
            >
              <option value="">自动归类</option>
              {SKILL_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        </aside>

        <section
          aria-label="文本工作区"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-canvas/30 px-2 sm:px-3">
            <button
              type="button"
              onClick={() => setMobileExplorerOpen(true)}
              aria-label="打开文件导航"
              aria-expanded={mobileExplorerOpen}
              className={fileActionClass + ' md:hidden'}
            >
              <PanelLeftOpen size={16} />
            </button>
            <FileText
              size={14}
              className="hidden shrink-0 text-primary sm:block"
            />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-body"
              title={selectedFile?.path}
            >
              {selectedFile?.path ?? '未选择文件'}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() =>
                  dispatchEditor({ type: 'startFileAction', action: 'rename' })
                }
                disabled={busy || selectedRequired}
                aria-label="重命名文件"
                title={selectedRequired ? '入口文件不能重命名' : '重命名文件'}
                className={fileActionClass}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteFile()}
                disabled={busy || selectedRequired}
                aria-label="删除文件"
                title={selectedRequired ? '入口文件不能删除' : '删除文件'}
                className={
                  fileActionClass + ' hover:bg-error/10 hover:text-error'
                }
              >
                <Trash2 size={13} />
              </button>
            </div>
            {isMarkdown ? (
              <div
                className="ml-1 flex shrink-0 items-center gap-0.5 border-l border-hairline pl-2"
                role="group"
                aria-label="编辑视图"
              >
                <button
                  type="button"
                  onClick={() =>
                    dispatchEditor({ type: 'setActiveTab', tab: 'edit' })
                  }
                  aria-pressed={activeTab === 'edit'}
                  aria-label="文本编辑"
                  className={
                    actionClass +
                    (activeTab === 'edit' ? ' bg-primary/10 text-primary' : '')
                  }
                >
                  <Code2 size={14} />
                  <span className="hidden sm:inline">编辑</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    dispatchEditor({ type: 'setActiveTab', tab: 'preview' })
                  }
                  aria-pressed={activeTab === 'preview'}
                  aria-label="预览"
                  className={
                    actionClass +
                    (activeTab === 'preview'
                      ? ' bg-primary/10 text-primary'
                      : '')
                  }
                >
                  <Eye size={14} />
                  <span className="hidden sm:inline">预览</span>
                </button>
              </div>
            ) : null}
          </div>

          {fileAction ? (
            <form
              className="shrink-0 space-y-2 border-b border-hairline bg-canvas/60 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                handleFilePath();
              }}
            >
              <label
                htmlFor="skill-editor-file-path"
                className="block text-[11px] font-medium text-muted"
              >
                {fileAction === 'rename'
                  ? '重命名文件 / 移动到目录'
                  : '新建文件，路径中可包含目录'}
              </label>
              <div className="flex gap-2">
                <input
                  ref={filePathInputRef}
                  id="skill-editor-file-path"
                  value={draftPath}
                  onChange={(event) =>
                    dispatchEditor({
                      type: 'setDraftPath',
                      value: event.currentTarget.value,
                    })
                  }
                  placeholder="docs/example.md"
                  disabled={busy}
                  aria-invalid={Boolean(pathError)}
                  aria-describedby={
                    pathError ? 'skill-editor-path-error' : undefined
                  }
                  className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-surface-raised px-2.5 font-mono text-[12px] text-ink placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-8 items-center justify-center rounded-md btn-tactile-primary px-3 text-[12px] font-medium text-on-primary disabled:opacity-50"
                >
                  {fileAction === 'rename' ? '确认' : '创建'}
                </button>
                <button
                  type="button"
                  onClick={() => dispatchEditor({ type: 'cancelFileAction' })}
                  aria-label="取消文件操作"
                  className={fileActionClass + ' h-8 w-8'}
                >
                  <X size={15} />
                </button>
              </div>
              {pathError ? (
                <p
                  id="skill-editor-path-error"
                  role="alert"
                  className="text-[11px] text-error"
                >
                  {pathError}
                </p>
              ) : null}
            </form>
          ) : null}

          {selectedFile ? (
            activeTab === 'preview' && isMarkdown ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1">
                  <MarkdownBundlePreview
                    content={
                      selectedFile.path === 'SKILL.md'
                        ? skillDraft.body
                        : selectedFile.content
                    }
                  />
                </div>
                <div className="flex h-8 shrink-0 items-center justify-between border-t border-hairline bg-canvas/60 px-4 text-[11px] text-muted">
                  <span>Markdown 预览</span>
                  <span>{selectedFile.content.length.toLocaleString()} 字</span>
                </div>
              </div>
            ) : (
              <SkillTextEditor
                key={selectedFile.path}
                file={selectedFile}
                readOnly={busy}
                onChange={(content) => updateFile(selectedFile.path, content)}
              />
            )
          ) : null}
        </section>
      </div>
    </div>
  );
}
