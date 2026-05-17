function findProcessEnvKey(name: string): string {
  const lower = name.toLowerCase();
  return (
    Object.keys(process.env).find((key) => key.toLowerCase() === lower) ?? name
  );
}

/**
 * 复制基础系统环境变量。
 * Windows 常见键名是 Path，不一定是 PATH；保留原键名可避免子进程找不到可执行文件。
 */
export function pickSystemEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'ComSpec',
  ]) {
    const envKey = findProcessEnvKey(key);
    const value = process.env[envKey];
    if (value) {
      result[envKey] = value;
    }
  }
  return result;
}
