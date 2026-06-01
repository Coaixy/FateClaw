type CacheClearer = () => void;

const cacheClearers = new Set<CacheClearer>();
let authCacheEpoch = 0;

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

function fingerprintToken(token: string | null): string {
  if (!token) {
    return 'anonymous';
  }

  let hashA = 2166136261;
  let hashB = 0;
  for (let index = 0; index < token.length; index += 1) {
    const charCode = token.charCodeAt(index);
    hashA ^= charCode;
    hashA = Math.imul(hashA, 16777619);
    hashB = Math.imul(hashB, 31) + charCode;
  }

  return `${token.length}:${(hashA >>> 0).toString(36)}:${(hashB >>> 0).toString(36)}`;
}

function getAuthCacheScopeKey() {
  return `${authCacheEpoch}:${fingerprintToken(getAuthTokenSnapshot())}`;
}

function registerAuthScopedCache(clear: CacheClearer) {
  cacheClearers.add(clear);
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
 * 清理所有按登录态隔离的前端 in-flight 请求缓存。
 * 同时推进 epoch，让已发出的旧 Promise 即使未结束也不会被后续调用复用。
 *
 * @returns 无返回值。
 */
export function clearAuthScopedCaches() {
  authCacheEpoch += 1;
  cacheClearers.forEach((clear) => clear());
}

/**
 * 写入新的 auth token，并立即清理所有依赖登录态的 in-flight 缓存。
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
 * 移除 auth token，并立即清理所有依赖登录态的 in-flight 缓存。
 * 登出或 401 失效时使用，避免旧请求继续污染当前会话。
 *
 * @returns 无返回值。
 */
export function removeAuthToken() {
  getBrowserStorage()?.removeItem('token');
  clearAuthScopedCaches();
}

/**
 * 创建按 auth token 指纹和 epoch 分区的 in-flight Promise 缓存。
 * 同一登录态下复用请求，token 切换或全局清理后会进入新的分区。
 *
 * @typeParam T 请求 Promise resolve 后的数据类型。
 * @returns 带 get 和 clear 方法的缓存对象；get 会在当前登录态内复用未完成请求。
 */
export function createAuthScopedInFlightCache<T>() {
  const requests = new Map<string, Promise<T>>();

  const clear = () => {
    requests.clear();
  };

  registerAuthScopedCache(clear);

  return {
    get(createRequest: () => Promise<T>) {
      const scopeKey = getAuthCacheScopeKey();
      const existingRequest = requests.get(scopeKey);
      if (existingRequest) {
        return existingRequest;
      }

      const request = createRequest().finally(() => {
        if (requests.get(scopeKey) === request) {
          requests.delete(scopeKey);
        }
      });
      requests.set(scopeKey, request);
      return request;
    },
    clear,
  };
}
