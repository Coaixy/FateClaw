import { useEffect, useState } from 'react';

/**
 * 防抖值：在 value 停止变化 delay 毫秒后才更新返回值。
 *
 * 用于搜索/筛选即时化——输入时输入框即时回显（不卡），但真正的过滤或请求
 * 在停顿后才触发，避免抖动与频繁请求。
 *
 * @param value 实时值。
 * @param delay 防抖毫秒，默认 300。
 * @returns 防抖后的值。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
