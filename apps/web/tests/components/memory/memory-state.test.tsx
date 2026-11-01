import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  MemoryEvidenceDto,
  MemoryJobDto,
} from '@fateclaw/contracts/memory';

import { MemoryEvidenceList } from '@/components/memory/memory-evidence-panel';
import { MemoryJobList } from '@/components/memory/memory-job-list';
import { I18nProvider } from '@/lib/i18n';

const job: MemoryJobDto = {
  id: 'backfill-1',
  kind: 'backfill',
  state: 'pending',
  attempts: 0,
  processed_count: 0,
  total_count: 10,
  error_code: null,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

describe('memory processing status', () => {
  function renderJob(state: MemoryJobDto['state']) {
    return renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <MemoryJobList
          status={{
            pending_jobs: state === 'pending' ? 1 : 0,
            failed_jobs: 0,
            active_items: 0,
            indexed_items: 0,
            recent_jobs: [{ ...job, state }],
          }}
          loading={false}
          error=""
          pending=""
          onRefresh={vi.fn()}
          onJobAction={vi.fn()}
        />
      </I18nProvider>,
    );
  }

  it('keeps queued processing distinct from completion and offers pause or resume from durable state', () => {
    const pending = renderJob('pending');
    expect(pending).toContain('等待处理');
    expect(pending).toContain('暂停');
    expect(pending).not.toContain('已完成');
    const paused = renderJob('paused');
    expect(paused).toContain('已暂停');
    expect(paused).toContain('继续');
    expect(renderJob('succeeded')).toContain('已完成');
  });
});

describe('memory evidence', () => {
  const source: MemoryEvidenceDto = {
    id: 'evidence-1',
    source_id: 'source-1',
    session_id: 'session?test=1',
    message_id: 'message-1',
    source_role: 'user',
    quote: '<script>synthetic quote</script>',
    observed_at: '2026-11-01T00:00:00Z',
    source_available: true,
  };

  it('renders the original quote as text and links to the exact source session', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <MemoryEvidenceList
          evidence={[source]}
          pending=""
          onExclude={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(html).toContain('&lt;script&gt;synthetic quote&lt;/script&gt;');
    expect(html).toContain('href="/ai-chat?sid=session%3Ftest%3D1"');
    expect(html).toContain('排除此来源');
  });

  it('does not expose a stale quote or conversation link after the source is unavailable', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <MemoryEvidenceList
          evidence={[{ ...source, source_available: false }]}
          pending=""
          onExclude={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(html).toContain('来源已删除或排除');
    expect(html).not.toContain('synthetic quote');
    expect(html).not.toContain('href="/ai-chat');
  });
});
