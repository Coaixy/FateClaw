'use client';

import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Code2,
  FileText,
  Plus,
  Trash2,
} from 'lucide-react';

import {
  createEmptySkillContentSection,
  parseSkillContentDraft,
  serializeSkillContentDraft,
  type SkillContentDraft,
} from '@/components/skills/skill-content-structure';

type EditorMode = 'structured' | 'markdown';

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export function SkillContentEditor({
  content,
  onChange,
  skillName,
}: {
  content: string;
  onChange: (nextContent: string) => void;
  skillName?: string;
}) {
  const [mode, setMode] = useState<EditorMode>('structured');
  const draft = useMemo(() => parseSkillContentDraft(content), [content]);

  const updateDraft = (nextDraft: SkillContentDraft) => {
    onChange(serializeSkillContentDraft(nextDraft));
  };

  const updateSection = (
    index: number,
    patch: Partial<SkillContentDraft['sections'][number]>,
  ) => {
    const nextSections = draft.sections.map((section, sectionIndex) =>
      sectionIndex === index ? { ...section, ...patch } : section,
    );
    updateDraft({
      ...draft,
      sections: nextSections,
    });
  };

  const addSection = () => {
    updateDraft({
      ...draft,
      sections: [...draft.sections, createEmptySkillContentSection()],
    });
  };

  const removeSection = (index: number) => {
    updateDraft({
      ...draft,
      sections: draft.sections.filter((_, sectionIndex) => sectionIndex !== index),
    });
  };

  const moveSection = (index: number, direction: 'up' | 'down') => {
    updateDraft({
      ...draft,
      sections: moveItem(
        draft.sections,
        index,
        direction === 'up' ? index - 1 : index + 1,
      ),
    });
  };

  const inputClass =
    'w-full rounded-xl border border-hairline bg-canvas px-3 py-2.5 text-[13px] placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none transition-all duration-200';

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl border border-hairline bg-canvas/65 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-ink">
            内容编辑方式
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted">
            默认按章节填写，系统会自动存成 Markdown；需要时也可以切到原文模式。
          </p>
        </div>
        <div className="grid w-full grid-cols-2 rounded-xl border border-hairline bg-surface-card p-1 sm:inline-flex sm:w-auto">
          <button
            type="button"
            onClick={() => setMode('structured')}
            className={`inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[11px] font-medium transition-colors ${
              mode === 'structured'
                ? 'bg-primary text-white'
                : 'text-muted hover:text-ink'
            }`}
          >
            <FileText size={12} />
            章节编辑
          </button>
          <button
            type="button"
            onClick={() => setMode('markdown')}
            className={`inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[11px] font-medium transition-colors ${
              mode === 'markdown'
                ? 'bg-primary text-white'
                : 'text-muted hover:text-ink'
            }`}
          >
            <Code2 size={12} />
            Markdown
          </button>
        </div>
      </div>

      {mode === 'structured' ? (
        <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted">
                正文标题（可选）
              </span>
              <input
                value={draft.title}
                onChange={(event) =>
                  updateDraft({
                    ...draft,
                    title: event.target.value,
                  })
                }
                placeholder={skillName || '例如：六爻财运判断框架'}
                className={inputClass}
              />
            </label>

            <label className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted">
                开场说明（可选）
              </span>
              <textarea
                value={draft.intro}
                onChange={(event) =>
                  updateDraft({
                    ...draft,
                    intro: event.target.value,
                  })
                }
                rows={3}
                placeholder="这里写适用场景、用户会怎么提问，或这份知识的总体用途。"
                className={`${inputClass} min-h-[92px] resize-y`}
              />
            </label>
          </div>

          <div className="space-y-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-ink">
                  章节列表
                </p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-muted">
                  每个章节标题会自动转成 `##`，正文里可以继续写步骤、列表和问答。
                </p>
              </div>
              <button
                type="button"
                onClick={addSection}
                className="inline-flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-hairline px-3 text-[11px] font-medium text-muted transition-colors hover:border-primary hover:bg-primary/5 hover:text-ink sm:w-auto"
              >
                <Plus size={12} />
                新增章节
              </button>
            </div>

            {draft.sections.length > 0 ? (
              draft.sections.map((section, index) => (
                <section
                  key={`${section.title}-${index}`}
                  className="rounded-2xl border border-hairline bg-surface-card/70 p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="rounded-full border border-hairline bg-canvas px-2 py-0.5 text-[10px] font-medium text-muted">
                        章节 {index + 1}
                      </span>
                      <span className="text-[10px] text-muted">
                        检索会优先依赖这里的标题定位内容
                      </span>
                    </div>
                    <div className="flex items-center gap-1 self-end sm:self-auto">
                      <button
                        type="button"
                        onClick={() => moveSection(index, 'up')}
                        disabled={index === 0}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="上移章节"
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveSection(index, 'down')}
                        disabled={index === draft.sections.length - 1}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="下移章节"
                      >
                        <ChevronDown size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSection(index)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/20 text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
                        aria-label="删除章节"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 space-y-3">
                    <label className="space-y-1.5">
                      <span className="text-[11px] font-medium text-muted">
                        章节标题
                      </span>
                      <input
                        value={section.title}
                        onChange={(event) =>
                          updateSection(index, { title: event.target.value })
                        }
                        placeholder="例如：适用场景、核心判断框架、常见追问"
                        className={inputClass}
                      />
                    </label>

                    <label className="space-y-1.5">
                      <span className="text-[11px] font-medium text-muted">
                        章节内容
                      </span>
                      <textarea
                        value={section.body}
                        onChange={(event) =>
                          updateSection(index, { body: event.target.value })
                        }
                        rows={6}
                        placeholder="这里写这一章的规则、步骤、边界、Q/A 或案例。换行、- 列表、Step 1、Q: A: 都可以直接写。"
                        className={`${inputClass} min-h-[160px] resize-y leading-relaxed`}
                      />
                    </label>
                  </div>
                </section>
              ))
            ) : null}
          </div>
        </div>
      ) : (
        <div>
          <textarea
            value={content}
            onChange={(event) => onChange(event.target.value)}
            maxLength={30000}
            rows={10}
            placeholder="在这里直接编辑 Markdown 原文"
            className="min-h-[280px] w-full resize-y rounded-xl border border-hairline bg-canvas px-3 py-3 font-mono text-[13px] leading-relaxed placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none transition-all duration-200"
          />
          <div className="mt-1.5 flex justify-between gap-2 text-[10px] text-muted">
            <span>切回“章节编辑”后，系统会按 `# / ##` 自动识别结构。</span>
            <span className="tabular-nums">{content.length.toLocaleString()} / 30,000</span>
          </div>
        </div>
      )}
    </div>
  );
}
