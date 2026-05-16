'use client';

import { BookOpenText, Hash, NotebookTabs } from 'lucide-react';
import { parseSkillContentDraft } from '@/components/skills/skill-content-structure';

function SectionCard({
  title,
  body,
  badge,
}: {
  title: string;
  body: string;
  badge: string;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-card/70 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-hairline bg-canvas px-2 py-0.5 text-[10px] font-medium text-muted">
          {badge}
        </span>
        <h4 className="min-w-0 truncate text-[12px] font-semibold text-ink">
          {title}
        </h4>
      </div>
      <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">
        {body || '这一章还没有正文内容。'}
      </pre>
    </section>
  );
}

export function SkillContentPreview({ content }: { content: string }) {
  const draft = parseSkillContentDraft(content);
  const sections =
    draft.sections.length > 0
      ? draft.sections
      : content.trim()
        ? [
            {
              title: draft.title ? '正文全文' : '正文预览',
              body: draft.intro || content.trim(),
            },
          ]
        : [];

  if (!content.trim()) {
    return (
      <div className="mt-3 rounded-xl border border-dashed border-hairline bg-surface-card/60 px-3 py-4 text-[11px] leading-relaxed text-muted">
        还没有填写正文内容，可以回到上一步补充。
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-2xl border border-hairline bg-surface-card/45 p-3">
      {draft.title && (
        <div className="rounded-xl border border-hairline bg-canvas/70 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted">
            <NotebookTabs size={11} className="text-primary" />
            技能主题
          </div>
          <p className="mt-1 text-[13px] font-semibold text-ink">
            {draft.title}
          </p>
        </div>
      )}

      <div className="mt-3 max-h-[360px] space-y-3 overflow-auto pr-1">
        {draft.intro && draft.sections.length > 0 && (
          <section className="rounded-xl border border-hairline bg-canvas/65 p-3">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-hairline bg-canvas px-2 py-0.5 text-[10px] font-medium text-muted">
                导语
              </span>
              <span className="text-[12px] font-semibold text-ink">
                开场说明
              </span>
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">
              {draft.intro}
            </pre>
          </section>
        )}

        {sections.map((section, index) => (
          <SectionCard
            key={`${section.title}-${index}`}
            title={section.title}
            body={section.body}
            badge={`章节 ${index + 1}`}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-muted">
        <span className="inline-flex items-center gap-1 rounded-full border border-hairline bg-canvas px-2 py-0.5">
          <BookOpenText size={10} />
          {sections.length} 个预览块
        </span>
        {draft.title && (
          <span className="inline-flex items-center gap-1 rounded-full border border-hairline bg-canvas px-2 py-0.5">
            <Hash size={10} />
            已识别技能标题
          </span>
        )}
      </div>
    </div>
  );
}
