'use client';

import { useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';

import type { TextSkillBundleFile } from '@/features/skills/api';

type FileNode = {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  children: FileNode[];
};

function buildFileTree(files: TextSkillBundleFile[]): FileNode[] {
  const root: FileNode[] = [];
  for (const file of files) {
    let children = root;
    const segments = file.path.split('/');
    segments.forEach((name, index) => {
      const path = segments.slice(0, index + 1).join('/');
      const kind = index === segments.length - 1 ? 'file' : 'folder';
      let node = children.find(
        (item) => item.path === path && item.kind === kind,
      );
      if (!node) {
        node = { name, path, kind, children: [] };
        children.push(node);
      }
      children = node.children;
    });
  }

  function sortNodes(nodes: FileNode[]): FileNode[] {
    return nodes
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
        if (left.path === 'SKILL.md') return -1;
        if (right.path === 'SKILL.md') return 1;
        return left.name.localeCompare(right.name);
      })
      .map((node) => ({ ...node, children: sortNodes(node.children) }));
  }

  return sortNodes(root);
}

export function SkillFileExplorer({
  files,
  selectedPath,
  collapsedFolders,
  dirtyPaths,
  onSelect,
  onToggleFolder,
}: {
  files: TextSkillBundleFile[];
  selectedPath: string;
  collapsedFolders: Set<string>;
  dirtyPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggleFolder: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);

  function renderNodes(nodes: FileNode[], depth = 0) {
    return (
      <ul className="space-y-0.5">
        {nodes.map((node) => {
          const isFolder = node.kind === 'folder';
          const expanded = !collapsedFolders.has(node.path);
          const selected = !isFolder && node.path === selectedPath;
          const Icon = isFolder
            ? expanded
              ? FolderOpen
              : Folder
            : /\.mdx?$/i.test(node.path)
              ? FileText
              : FileCode2;

          return (
            <li key={`${node.kind}:${node.path}`}>
              <button
                type="button"
                onClick={() =>
                  isFolder ? onToggleFolder(node.path) : onSelect(node.path)
                }
                aria-expanded={isFolder ? expanded : undefined}
                aria-current={selected ? 'page' : undefined}
                title={node.path}
                style={{ paddingLeft: 12 + depth * 16 }}
                className={`flex min-h-9 w-full items-center gap-2 border-l-2 pr-3 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${
                  selected
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-transparent text-body hover:bg-surface-cream-strong/50 hover:text-ink'
                }`}
              >
                {isFolder ? (
                  expanded ? (
                    <ChevronDown size={12} className="shrink-0 text-muted" />
                  ) : (
                    <ChevronRight size={12} className="shrink-0 text-muted" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <Icon
                  size={15}
                  strokeWidth={1.6}
                  className={`shrink-0 ${isFolder ? 'text-muted' : selected ? 'text-primary' : 'text-muted/80'}`}
                />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {node.name}
                </span>
                {node.path === 'SKILL.md' ? (
                  <span className="shrink-0 text-[10px] text-muted">入口</span>
                ) : null}
                {!isFolder && dirtyPaths.has(node.path) ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                    aria-label="未保存"
                  />
                ) : null}
              </button>
              {isFolder && expanded
                ? renderNodes(node.children, depth + 1)
                : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <nav aria-label="Skill 文件" className="py-2">
      {renderNodes(tree)}
    </nav>
  );
}
