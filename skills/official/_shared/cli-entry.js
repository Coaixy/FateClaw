import path from 'path';
import { fileURLToPath } from 'url';

function normalizeCliPath(filePath) {
  if (process.platform === 'win32') {
    const windowsPath = filePath.replace(/^\/([a-zA-Z]:[\\/])/, '$1');
    // Windows 文件系统大小写不敏感；转小写避免盘符大小写差异导致入口判断失败。
    return path.win32.normalize(path.win32.resolve(windowsPath)).toLowerCase();
  }
  return path.normalize(path.resolve(filePath));
}

/**
 * 判断当前 ESM 文件是否由 Node CLI 直接执行。
 *
 * 不能用 `new URL(import.meta.url).pathname === process.argv[1]`：
 * Windows 下 file URL 会变成 `/C:/...`，而 argv 是 `C:\...`，导致脚本静默不输出。
 */
export function isDirectCliRun(importMetaUrl) {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  return (
    normalizeCliPath(fileURLToPath(importMetaUrl)) ===
    normalizeCliPath(process.argv[1])
  );
}
