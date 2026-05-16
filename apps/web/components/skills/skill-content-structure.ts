export type SkillContentSectionDraft = {
  title: string;
  body: string;
};

export type SkillContentDraft = {
  title: string;
  intro: string;
  sections: SkillContentSectionDraft[];
};

export const UNTITLED_SECTION_TITLE = '未命名章节';

export function createEmptySkillContentSection(): SkillContentSectionDraft {
  return {
    title: '',
    body: '',
  };
}

export function parseSkillContentDraft(content: string): SkillContentDraft {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      title: '',
      intro: '',
      sections: [],
    };
  }

  const lines = trimmed.replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  const introLines: string[] = [];
  const sections: Array<{ title: string; lines: string[] }> = [];
  let currentSection: { title: string; lines: string[] } | null = null;

  const pushCurrentSection = () => {
    if (!currentSection) return;
    sections.push({
      title: currentSection.title,
      lines: [...currentSection.lines],
    });
    currentSection = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const h1 = line.match(/^#\s+(.+)/);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }

    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      pushCurrentSection();
      currentSection = {
        title: h2[1].trim(),
        lines: [],
      };
      continue;
    }

    if (currentSection) {
      currentSection.lines.push(line);
      continue;
    }

    introLines.push(line);
  }

  pushCurrentSection();

  return {
    title,
    intro: introLines.join('\n').trim(),
    sections: sections
      .map((section) => ({
        title: section.title,
        body: section.lines.join('\n').trim(),
      }))
      .filter((section) => section.title || section.body),
  };
}

export function serializeSkillContentDraft(
  draft: SkillContentDraft,
): string {
  const blocks: string[] = [];
  const title = draft.title.trim();
  const intro = draft.intro.trim();
  const sections = draft.sections
    .map((section) => ({
      title: section.title.trim(),
      body: section.body.trim(),
    }))
    .filter((section) => section.title || section.body);

  if (title) {
    blocks.push(`# ${title}`);
  }

  if (intro) {
    blocks.push(intro);
  }

  for (const section of sections) {
    blocks.push(`## ${section.title || UNTITLED_SECTION_TITLE}`);
    if (section.body) {
      blocks.push(section.body);
    }
  }

  return blocks.join('\n\n').trim();
}
