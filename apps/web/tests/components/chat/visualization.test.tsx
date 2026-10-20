import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { VisualizationContext } from '@/components/chat/visualization-context';
import { I18nProvider } from '@/lib/i18n';
import { visualizationReference } from '@fateclaw/contracts/visualization';

vi.mock('@/components/chat/artifact-renderer', () => ({
  ArtifactRenderer: ({
    entries,
  }: {
    entries: Array<{ artifactTitle: string }>;
  }) => <figure>{entries[0].artifactTitle}</figure>,
}));
const id = `visualization-${'a'.repeat(64)}`;
const reference = visualizationReference(id);

function render(content: string, pending = false, available = true) {
  const entry = {
    skill: 'visualization',
    output: '测试数据的分布。',
    artifactType: 'visualization',
    artifactTitle: '分布图',
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <VisualizationContext
        value={{ entries: new Map(available ? [[id, entry]] : []), pending }}
      >
        <MarkdownContent content={content} isBot />
      </VisualizationContext>
    </I18nProvider>,
  );
}

describe('inline visualizations', () => {
  it('renders a figure between its surrounding paragraphs and preserves ordinary code examples', () => {
    const html = render(`图前说明\n\n${reference}\n\n图后说明`);
    expect(html.indexOf('图前说明')).toBeLessThan(
      html.indexOf('<figure>分布图</figure>'),
    );
    expect(html.indexOf('<figure>分布图</figure>')).toBeLessThan(
      html.indexOf('图后说明'),
    );
    expect(html).not.toContain(id);
    const example = render(`\`\`\`\`markdown\n${reference}\n\`\`\`\``);
    expect(example).toContain('<pre');
    expect(example).not.toContain('<figure>');
  });

  it('keeps the explanation when a reference is pending or unavailable', () => {
    const loading = render(`文字说明\n\n${reference}`, true, false);
    expect(loading).toContain('正在生成图形');
    const missing = render(`文字说明\n\n${reference}`, false, false);
    expect(missing).toContain('暂时无法加载这张图形');
    expect(missing).toContain('文字说明');
    expect(missing).not.toContain(id);
  });
});
