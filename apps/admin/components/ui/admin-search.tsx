'use client';

import type { InputHTMLAttributes } from 'react';
import { Search, X } from 'lucide-react';

/**
 * 后台统一搜索框：左侧搜索图标 + 有内容时右侧一键清除 + 回车回调。
 *
 * 受控组件；防抖交给调用方（配合 useDebouncedValue），以便客户端过滤或重新请求自由选择。
 *
 * @param value 当前输入值。
 * @param onValueChange 输入变化回调（传纯文本）。
 * @param onEnter 回车回调，可选。
 * @param onClear 清除回调，可选；不传则默认 onValueChange('')。
 * @param placeholder 占位文案，默认「搜索」。
 */
export function AdminSearchInput({
  value,
  onValueChange,
  onEnter,
  onClear,
  placeholder = '搜索',
  className = '',
  ...props
}: {
  value: string;
  onValueChange: (value: string) => void;
  onEnter?: () => void;
  onClear?: () => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <div className={`relative ${className}`}>
      <Search
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onEnter?.();
        }}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-hairline bg-canvas pl-8 pr-8 text-[13px] outline-none transition-colors focus:border-primary/45"
        {...props}
      />
      {value ? (
        <button
          type="button"
          onClick={() => (onClear ? onClear() : onValueChange(''))}
          aria-label="清除"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:text-ink"
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}
