import { describe, expect, it } from 'vitest';

import { resolveStaticExportRequest } from '#interfaces/http/static-export';

describe('resolveStaticExportRequest', () => {
  it('keeps API misses out of the static export fallback', () => {
    expect(resolveStaticExportRequest('/api/missing')).toEqual({
      kind: 'api-404',
      candidateFiles: [],
      fallbackToIndexHtml: false,
    });
  });

  it('does not map retired announcement pages to a placeholder', () => {
    expect(
      resolveStaticExportRequest('/announcements/summer-maintenance'),
    ).toEqual({
      kind: 'page',
      candidateFiles: [
        'announcements/summer-maintenance/index.html',
        'announcements/summer-maintenance.html',
      ],
      fallbackToIndexHtml: false,
    });
  });

  it('does not map retired announcement route data to a placeholder', () => {
    expect(
      resolveStaticExportRequest('/announcements/summer-maintenance.txt'),
    ).toEqual({
      kind: 'asset',
      candidateFiles: [
        'announcements/summer-maintenance.txt',
        'announcements/summer-maintenance/index.txt',
      ],
      fallbackToIndexHtml: false,
    });
  });

  it('resolves page exports without falling back to the home page', () => {
    expect(resolveStaticExportRequest('/ai-chat/?sid=session-1')).toEqual({
      kind: 'page',
      candidateFiles: ['ai-chat/index.html', 'ai-chat.html'],
      fallbackToIndexHtml: false,
    });
  });

  it('resolves route data shortcuts to the exported data file', () => {
    expect(resolveStaticExportRequest('/ai-chat.txt')).toEqual({
      kind: 'asset',
      candidateFiles: ['ai-chat.txt', 'ai-chat/index.txt'],
      fallbackToIndexHtml: false,
    });
  });
});
