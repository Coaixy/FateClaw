/**
 * 统一的 stderr 日志前缀，方便宿主机在混合日志里筛选容器日志。
 */
export function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}
