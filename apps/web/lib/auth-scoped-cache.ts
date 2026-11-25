type CacheClearer = () => void;

const cacheClearers = new Set<CacheClearer>();

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 读取当前浏览器里的 auth token 快照。
 * 返回值只用于比较当前登录态是否已切换，不负责鉴权。
 *
 * @returns 当前 localStorage token；服务端渲染或不可访问时返回 null。
 */
export function getAuthTokenSnapshot(): string | null {
  return getBrowserStorage()?.getItem('token') ?? null;
}

/**
 * 判断传入的 token 快照是否仍是当前登录态。
 * 用于阻止旧请求在 token 切换后回写用户状态。
 *
 * @param snapshot 请求发起时记录的 token 快照。
 * @returns 快照仍匹配当前 token 时返回 true。
 */
export function isAuthTokenSnapshotCurrent(snapshot: string | null): boolean {
  return getAuthTokenSnapshot() === snapshot;
}

/**
 * 清理所有按登录态隔离的请求和结果缓存。旧请求完成后也不能回填缓存。
 *
 * @returns 无返回值。
 */
export function clearAuthScopedCaches() {
  cacheClearers.forEach((clear) => clear());
}

/**
 * 写入新的 auth token，并立即清理所有依赖登录态的缓存。
 * 登录、注册和换 token 场景都应走这里，避免复用旧用户请求。
 *
 * @param token 新的登录 token。
 * @returns 无返回值。
 */
export function setAuthToken(token: string) {
  getBrowserStorage()?.setItem('token', token);
  clearAuthScopedCaches();
}

/**
 * 移除 auth token，并立即清理所有依赖登录态的缓存。
 * 登出或 401 失效时使用，避免旧请求继续污染当前会话。
 *
 * @returns 无返回值。
 */
export function removeAuthToken() {
  getBrowserStorage()?.removeItem('token');
  clearAuthScopedCaches();
}

/**
 * 复用当前登录态的在途请求。配置 maxAgeMs 后，将登录用户成功返回的结果短暂保存在内存中。
 */
export function createAuthScopedInFlightCache<T>({
  maxAgeMs = 0,
}: { maxAgeMs?: number } = {}) {
  let inFlight: { token: string | null; promise: Promise<T> } | undefined;
  let snapshot: { token: string; value: T; expiresAt: number } | undefined;

  const clear = () => {
    inFlight = undefined;
    snapshot = undefined;
  };

  const peek = () => {
    if (
      snapshot &&
      isAuthTokenSnapshotCurrent(snapshot.token) &&
      snapshot.expiresAt > Date.now()
    ) {
      return snapshot.value;
    }
    snapshot = undefined;
    return undefined;
  };

  cacheClearers.add(clear);

  return {
    get(createRequest: () => Promise<T>, { refresh = false } = {}) {
      const token = getAuthTokenSnapshot();
      if (inFlight?.token === token) {
        return inFlight.promise;
      }

      const cached = peek();
      if (!refresh && cached !== undefined) return Promise.resolve(cached);

      const promise = createRequest()
        .then((value) => {
          if (
            maxAgeMs > 0 &&
            token &&
            inFlight?.promise === promise &&
            isAuthTokenSnapshotCurrent(token)
          ) {
            snapshot = { token, value, expiresAt: Date.now() + maxAgeMs };
          }
          return value;
        })
        .finally(() => {
          if (inFlight?.promise === promise) inFlight = undefined;
        });
      inFlight = { token, promise };
      return promise;
    },
    peek,
    clear,
  };
}
