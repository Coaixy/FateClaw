import { describe, expect, it } from 'vitest';

import { resolveStaticExportRequest } from '../../../src/interfaces/http/static-export.js';

describe('resolveStaticExportRequest', () => {
  it('keeps API misses out of the static export fallback', () => {
    expect(resolveStaticExportRequest('/api/public/announcements')).toEqual({
      kind: 'api-404',
      candidateFiles: [],
      fallbackToIndexHtml: false,
    });
  });

  it('maps announcement detail pages to the exported placeholder page', () => {
    expect(
      resolveStaticExportRequest('/announcements/summer-maintenance'),
    ).toEqual({
      kind: 'page',
      candidateFiles: [
        'announcements/summer-maintenance/index.html',
        'announcements/summer-maintenance.html',
        'announcements/detail/index.html',
        'announcements/detail.html',
      ],
      fallbackToIndexHtml: false,
    });
  });

  it('maps announcement route data shortcuts to the exported placeholder data', () => {
    expect(
      resolveStaticExportRequest('/announcements/summer-maintenance.txt'),
    ).toEqual({
      kind: 'asset',
      candidateFiles: [
        'announcements/summer-maintenance.txt',
        'announcements/summer-maintenance/index.txt',
        'announcements/detail/index.txt',
        'announcements/detail.txt',
      ],
      fallbackToIndexHtml: false,
    });
  });

  it('does not map the announcement list page to the detail placeholder', () => {
    expect(resolveStaticExportRequest('/announcements')).toEqual({
      kind: 'page',
      candidateFiles: ['announcements/index.html', 'announcements.html'],
      fallbackToIndexHtml: false,
    });
  });
});
