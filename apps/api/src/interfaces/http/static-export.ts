import path from 'path';

/** 静态导出请求解析结果。 */
export type StaticExportRequestResolution =
  | {
      kind: 'api-404';
      candidateFiles: string[];
      fallbackToIndexHtml: false;
    }
  | {
      kind: 'asset';
      candidateFiles: string[];
      fallbackToIndexHtml: false;
    }
  | {
      kind: 'page';
      candidateFiles: string[];
      fallbackToIndexHtml: boolean;
    };

function normalizeRequestPath(requestUrl: string): string {
  const pathname = requestUrl.split('?')[0] || '/';
  if (pathname === '/') return '/';
  const trimmedPath = pathname.replace(/\/+$/, '');
  return trimmedPath || '/';
}

function pushCandidate(candidates: Set<string>, candidate: string) {
  if (!candidate) return;
  candidates.add(candidate.replace(/^\/+/, ''));
}

function isRouteDataShortcut(routePath: string): boolean {
  const basename = path.posix.basename(routePath);
  return basename !== 'index.txt' && !basename.startsWith('__next.');
}

/**
 * 解析静态导出文件请求。
 *
 * @param requestUrl 原始请求 URL，可包含查询参数。
 * @returns 静态文件候选和是否允许兜底首页。
 */
export function resolveStaticExportRequest(
  requestUrl: string,
): StaticExportRequestResolution {
  const urlPath = normalizeRequestPath(requestUrl);

  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    return {
      kind: 'api-404',
      candidateFiles: [],
      fallbackToIndexHtml: false,
    };
  }

  if (urlPath === '/') {
    return {
      kind: 'page',
      candidateFiles: ['index.html'],
      fallbackToIndexHtml: true,
    };
  }

  const routePath = urlPath.slice(1);
  const candidateFiles = new Set<string>();
  const extension = path.posix.extname(routePath);

  if (extension) {
    pushCandidate(candidateFiles, routePath);
  }

  if (!extension) {
    pushCandidate(candidateFiles, path.posix.join(routePath, 'index.html'));
    pushCandidate(candidateFiles, `${routePath}.html`);
    return {
      kind: 'page',
      candidateFiles: [...candidateFiles],
      // 静态导出页只要产物存在就会命中 candidateFiles。
      // 如果页面产物缺失，继续兜底首页只会把“缺文件/漏部署”伪装成“跳回首页”。
      fallbackToIndexHtml: false,
    };
  }

  // Next 生产静态导出在客户端跳转时会把 `/route` 改写成 `/route.txt`，
  // 实际产物却落成 `route/index.txt`，这里需要把短路径补回真实文件。
  if (extension === '.txt' && isRouteDataShortcut(routePath)) {
    const routeWithoutExtension = routePath.slice(0, -extension.length);
    pushCandidate(
      candidateFiles,
      path.posix.join(routeWithoutExtension, 'index.txt'),
    );
    pushCandidate(candidateFiles, `${routeWithoutExtension}.txt`);
  }

  return {
    kind: 'asset',
    candidateFiles: [...candidateFiles],
    fallbackToIndexHtml: false,
  };
}
