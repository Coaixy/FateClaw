import { useEffect } from 'react';

/**
 * 监听 Esc 键并触发回调；常用于关闭弹层 / 抽屉 / 展开面板。
 *
 * @param handler Esc 按下时执行（通常是关闭函数）。
 * @param enabled 是否启用监听，默认 true；弹层未打开时传 false 可停掉监听。
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handler, enabled]);
}
