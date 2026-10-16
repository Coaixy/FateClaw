'use client';

import { useMemo, useReducer } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  LockKeyhole,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { TextSkillBundleFileDto } from '@fateclaw/contracts/skills';

import { MarkdownContent } from '@/components/chat/markdown-content';
import { shortRevision } from '@/lib/skill-storage';

type FileNode = {
  name: string;
  path: string;
  folder: boolean;
  children: FileNode[];
};

function buildFileTree(files: TextSkillBundleFileDto[]): FileNode[] {
  const root: FileNode[] = [];
  for (const file of files) {
    let children = root;
    const segments = file.path.split('/');
    segments.forEach((name, index) => {
      const path = segments.slice(0, index + 1).join('/');
      let node = children.find((item) => item.path === path);
      if (!node) {
        node = {
          name,
          path,
          folder: index < segments.length - 1,
          children: [],
        };
        children.push(node);
      }
      children = node.children;
    });
  }

  function sortNodes(nodes: FileNode[]): FileNode[] {
    return nodes
      .sort((left, right) => {
        if (left.folder !== right.folder) return left.folder ? -1 : 1;
        if (left.path === 'SKILL.md') return -1;
        if (right.path === 'SKILL.md') return 1;
        return left.name.localeCompare(right.name);
      })
      .map((node) => ({ ...node, children: sortNodes(node.children) }));
  }

  return sortNodes(root);
}

type BrowserState = {
  selectedPath: string;
  view: 'source' | 'preview';
  mobileOpen: boolean;
  collapsedFolders: Set<string>;
  copyStatus: 'idle' | 'copied' | 'failed';
};

type BrowserAction =
  | { type: 'select'; path: string }
  | { type: 'view'; view: BrowserState['view'] }
  | { type: 'mobile'; open: boolean }
  | { type: 'folder'; path: string }
  | { type: 'copy'; status: BrowserState['copyStatus']; path: string };

function browserReducer(
  state: BrowserState,
  action: BrowserAction,
): BrowserState {
  switch (action.type) {
    case 'select':
      return {
        ...state,
        selectedPath: action.path,
        view: 'source',
        mobileOpen: false,
        copyStatus: 'idle',
      };
    case 'view':
      return { ...state, view: action.view };
    case 'mobile':
      return { ...state, mobileOpen: action.open };
    case 'folder': {
      const collapsedFolders = new Set(state.collapsedFolders);
      if (collapsedFolders.has(action.path))
        collapsedFolders.delete(action.path);
      else collapsedFolders.add(action.path);
      return { ...state, collapsedFolders };
    }
    case 'copy':
      return action.path === state.selectedPath
        ? { ...state, copyStatus: action.status }
        : state;
  }
}

export function SkillFileBrowser({
  files,
  revisionId,
}: {
  files: TextSkillBundleFileDto[];
  revisionId: string | null;
}) {
  const [state, dispatch] = useReducer(
    browserReducer,
    files,
    (initialFiles): BrowserState => ({
      selectedPath:
        initialFiles.find((file) => file.path === 'SKILL.md')?.path ??
        initialFiles[0]?.path ??
        '',
      view: 'source',
      mobileOpen: false,
      collapsedFolders: new Set(),
      copyStatus: 'idle',
    }),
  );
  const tree = useMemo(() => buildFileTree(files), [files]);
  const selectedFile =
    files.find((file) => file.path === state.selectedPath) ?? files[0];
  const lineCount = selectedFile ? selectedFile.content.split('\n').length : 0;
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join('\n'),
    [lineCount],
  );
  const isMarkdown = selectedFile ? /\.mdx?$/i.test(selectedFile.path) : false;
  const language = isMarkdown
    ? 'Markdown'
    : selectedFile?.path.split('.').pop()?.toUpperCase();

  async function copyFile() {
    if (!selectedFile) return;
    try {
      await navigator.clipboard.writeText(selectedFile.content);
      dispatch({ type: 'copy', status: 'copied', path: selectedFile.path });
    } catch {
      dispatch({ type: 'copy', status: 'failed', path: selectedFile.path });
    }
  }

  function renderNodes(nodes: FileNode[], depth = 0) {
    return (
      <ul className="space-y-0.5">
        {nodes.map((node) => {
          const expanded = !state.collapsedFolders.has(node.path);
          const selected = !node.folder && node.path === selectedFile?.path;
          const Icon = node.folder
            ? expanded
              ? FolderOpen
              : Folder
            : /\.mdx?$/i.test(node.path)
              ? FileText
              : FileCode2;

          return (
            <li key={node.path}>
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: node.folder ? 'folder' : 'select',
                    path: node.path,
                  })
                }
                aria-expanded={node.folder ? expanded : undefined}
                aria-current={selected ? 'page' : undefined}
                title={node.path}
                style={{ paddingLeft: 10 + depth * 16 }}
                className={`flex min-h-9 w-full cursor-pointer items-center gap-2 border-l-2 pr-3 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${selected ? 'border-primary bg-primary/10 text-primary' : 'border-transparent text-body hover:bg-surface-cream-strong/60 hover:text-ink'}`}
              >
                {node.folder ? (
                  expanded ? (
                    <ChevronDown size={12} className="shrink-0 text-muted" />
                  ) : (
                    <ChevronRight size={12} className="shrink-0 text-muted" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <Icon size={14} strokeWidth={1.6} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {node.name}
                </span>
                {node.path === 'SKILL.md' ? (
                  <span className="shrink-0 text-[10px] text-muted">入口</span>
                ) : null}
              </button>
              {node.folder && expanded
                ? renderNodes(node.children, depth + 1)
                : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const toolbarClass =
    'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

  return (
    <section
      aria-label="当前修订文件"
      className="flex h-[70dvh] min-h-[480px] flex-col overflow-hidden rounded-xl border border-hairline bg-canvas"
      onKeyDown={(event) => {
        if (event.key === 'Escape') dispatch({ type: 'mobile', open: false });
      }}
    >
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-surface-card/60 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <BookOpen
            size={16}
            strokeWidth={1.6}
            className="shrink-0 text-primary"
          />
          <h2 className="truncate text-[13px] font-semibold text-ink">
            当前修订文件
          </h2>
          <span
            className="hidden shrink-0 font-mono text-[10px] text-muted sm:inline"
            title={revisionId ?? undefined}
          >
            {shortRevision(revisionId)}
          </span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-canvas px-2 py-1 text-[10px] text-muted">
          <LockKeyhole size={11} />
          只读
        </span>
      </header>

      {!selectedFile ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[13px] leading-6 text-muted">
          <FileText size={28} strokeWidth={1.2} className="text-muted/50" />
          <p>
            正文尚未入库，暂无法查看文件。
            <br />
            请检查下方显示的迁移状态。
          </p>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {state.mobileOpen ? (
            <button
              type="button"
              aria-label="关闭文件导航"
              onClick={() => dispatch({ type: 'mobile', open: false })}
              className="absolute inset-0 z-10 bg-ink/20 md:hidden"
            />
          ) : null}
          <aside
            aria-label="文件导航"
            className={`${state.mobileOpen ? 'absolute inset-y-0 left-0 z-20 flex shadow-xl' : 'hidden'} w-60 max-w-[85%] shrink-0 flex-col border-r border-hairline bg-surface-soft md:static md:z-auto md:flex md:w-52 md:shadow-none lg:w-56`}
          >
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-hairline/70 px-3">
              <h3 className="flex items-center gap-2 text-[11px] font-medium text-muted">
                文件
                <span className="font-normal tabular-nums text-muted/70">
                  {files.length}
                </span>
              </h3>
              <button
                type="button"
                aria-label="收起文件导航"
                onClick={() => dispatch({ type: 'mobile', open: false })}
                className={
                  toolbarClass + ' text-muted hover:text-ink md:hidden'
                }
              >
                <PanelLeftClose size={15} />
              </button>
            </div>
            <nav
              aria-label="修订文件目录"
              className="min-h-0 flex-1 overflow-auto py-2"
            >
              {renderNodes(tree)}
            </nav>
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-hairline px-3 text-[10px] text-muted">
              <LockKeyhole size={10} />
              当前修订 · {files.length} 个文件
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-surface-soft/40 px-2 sm:px-3">
              <button
                type="button"
                aria-label="打开文件导航"
                aria-expanded={state.mobileOpen}
                onClick={() => dispatch({ type: 'mobile', open: true })}
                className={
                  toolbarClass + ' text-muted hover:text-ink md:hidden'
                }
              >
                <PanelLeftOpen size={16} />
              </button>
              <FileText
                size={14}
                className="hidden shrink-0 text-primary sm:block"
              />
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-body"
                title={selectedFile.path}
              >
                {selectedFile.path}
              </span>
              {isMarkdown ? (
                <div
                  className="flex shrink-0 items-center gap-0.5"
                  role="group"
                  aria-label="文件视图"
                >
                  <button
                    type="button"
                    aria-label="源文件"
                    aria-pressed={state.view === 'source'}
                    onClick={() => dispatch({ type: 'view', view: 'source' })}
                    className={
                      toolbarClass +
                      (state.view === 'source'
                        ? ' bg-primary/10 text-primary'
                        : ' text-muted hover:text-ink')
                    }
                  >
                    <Code2 size={14} />
                    <span className="hidden sm:inline">源文件</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Markdown 预览"
                    aria-pressed={state.view === 'preview'}
                    onClick={() => dispatch({ type: 'view', view: 'preview' })}
                    className={
                      toolbarClass +
                      (state.view === 'preview'
                        ? ' bg-primary/10 text-primary'
                        : ' text-muted hover:text-ink')
                    }
                  >
                    <Eye size={14} />
                    <span className="hidden sm:inline">预览</span>
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                aria-label="复制文件内容"
                title="复制文件内容"
                onClick={() => void copyFile()}
                className={
                  toolbarClass +
                  ' border-l border-hairline text-muted hover:text-primary'
                }
              >
                {state.copyStatus === 'copied' ? (
                  <Check size={14} className="text-success" />
                ) : (
                  <Copy size={14} />
                )}
                <span className="hidden lg:inline">
                  {state.copyStatus === 'copied' ? '已复制' : '复制'}
                </span>
              </button>
            </div>

            {state.copyStatus === 'failed' ? (
              <p
                role="alert"
                className="shrink-0 border-b border-hairline bg-surface-soft px-4 py-2 text-[11px] text-error"
              >
                复制失败，请直接选中原文复制。
              </p>
            ) : null}

            {state.view === 'preview' && isMarkdown ? (
              <div
                key={selectedFile.path + ':preview'}
                aria-label="Markdown 文件预览"
                className="min-h-0 flex-1 overflow-auto p-5 text-[13px] leading-7 text-body sm:p-6"
              >
                <MarkdownContent
                  content={selectedFile.content.replace(
                    /^---\r?\n[\s\S]*?\r?\n---\r?\n?/,
                    '',
                  )}
                  isBot
                />
              </div>
            ) : (
              <div
                key={selectedFile.path + ':source'}
                className="min-h-0 flex-1 overflow-auto"
                aria-label="只读文件内容"
              >
                <div className="flex min-h-full min-w-max font-mono text-[13px] leading-6">
                  <pre
                    aria-hidden="true"
                    className="sticky left-0 w-12 shrink-0 select-none border-r border-hairline/60 bg-canvas py-4 pr-3 text-right font-mono text-[13px] leading-6 text-muted/50"
                  >
                    {lineNumbers}
                  </pre>
                  <pre
                    tabIndex={0}
                    aria-label={selectedFile.path + ' 原文'}
                    style={{ tabSize: 2 }}
                    className="min-w-0 flex-1 whitespace-pre px-4 py-4 font-mono text-[13px] leading-6 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/25"
                  >
                    <code>{selectedFile.content || '\n'}</code>
                  </pre>
                </div>
              </div>
            )}

            <footer className="flex h-8 shrink-0 items-center justify-between gap-2 border-t border-hairline bg-surface-soft/40 px-3 text-[10px] tabular-nums text-muted sm:px-4 sm:text-[11px]">
              <span role="status">
                {state.copyStatus === 'copied'
                  ? '文件内容已复制'
                  : state.view === 'preview' && isMarkdown
                    ? 'Markdown 预览'
                    : '只读原文'}
              </span>
              <span className="flex items-center gap-3">
                <span>{lineCount.toLocaleString()} 行</span>
                <span>{selectedFile.content.length.toLocaleString()} 字</span>
                <span className="hidden sm:inline">{language}</span>
                <span className="hidden sm:inline">UTF-8</span>
              </span>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
