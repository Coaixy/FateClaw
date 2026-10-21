'use client';

import { useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { Check, Copy, Loader2, type LucideIcon } from 'lucide-react';

/**
 * 表单控件统一基础类。
 *
 * 复刻各后台页历史内联样式
 * `h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px]`，
 * 仅把原先的 `focus:border-hairline`（无焦点反馈）统一升级为细微的主色聚焦边框，
 * 作为全后台一致性收敛的一部分。
 */
const CONTROL_BASE =
  'w-full rounded-md border border-hairline bg-canvas text-[13px] outline-none transition-colors focus:border-primary/45 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * 表单字段容器：统一 label + 说明 + 控件的竖向排版。
 *
 * 复刻各页历史的 `<label className="min-w-0"><span>…</span>{control}</label>` 结构，
 * 额外支持必填星标与字段说明（hint）。
 *
 * @param label 字段标题。
 * @param hint 字段下方的补充说明，可选。
 * @param required 是否展示必填星标，可选。
 * @param children 实际的输入控件。
 */
export function AdminField({
  label,
  hint,
  required,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-1 block text-[12px] text-muted">
        {label}
        {required ? <span className="ml-0.5 text-error">*</span> : null}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] leading-4 text-muted-soft">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/** 后台统一文本输入框，沿用全站控件基础样式。 */
export function AdminInput({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input className={`h-9 px-2.5 ${CONTROL_BASE} ${className}`} {...props} />
  );
}

/** 后台统一多行文本框，默认禁止水平拉伸。 */
export function AdminTextarea({
  className = '',
  rows = 3,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={rows}
      className={`resize-y px-2.5 py-2 leading-relaxed ${CONTROL_BASE} ${className}`}
      {...props}
    />
  );
}

/**
 * 后台主操作按钮，统一保存/确认类操作的主色视觉。
 *
 * Loading feedback prevents duplicate submissions.
 *
 * @param loading 是否处于加载态。
 * @param icon 左侧图标，可选。
 */
export function AdminPrimaryButton({
  icon: Icon,
  loading = false,
  children,
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-3.5 text-[13px] font-medium text-on-primary transition-colors hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 size={13} className="animate-spin" />
      ) : Icon ? (
        <Icon size={13} />
      ) : null}
      {children}
    </button>
  );
}

/** 后台次级按钮，用于取消/重置类弱操作。 */
export function AdminSecondaryButton({
  icon: Icon,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      className={`inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-hairline bg-surface-card px-3.5 text-[13px] font-medium text-body transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
      {...props}
    >
      {Icon ? <Icon size={13} /> : null}
      {children}
    </button>
  );
}

/**
 * 一键复制按钮：复制 text 到剪贴板，短暂显示「已复制」反馈。
 *
 * 用于表格里的用户 ID、手机号、session id 等需要快速取用的字段。
 *
 * @param text 要复制的文本。
 * @param label 可选可见文案；不传则只显示图标。
 */
export function AdminCopyButton({
  text,
  label,
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 复制失败静默：用户仍可手动选中文本。
    }
  };
  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      title="复制"
      aria-label="复制"
      className={`inline-flex items-center gap-1 rounded p-0.5 align-middle text-muted transition-colors hover:text-primary ${className}`}
    >
      {copied ? (
        <Check size={12} className="text-success" />
      ) : (
        <Copy size={12} />
      )}
      {label ? <span className="text-[11px]">{label}</span> : null}
    </button>
  );
}

type AdminBadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'error';

const badgeToneClass: Record<AdminBadgeTone, string> = {
  neutral: 'border-hairline bg-surface-card text-muted',
  primary: 'border-primary/30 bg-primary/10 text-primary',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  error: 'border-error/30 bg-error/10 text-error',
};

/**
 * 后台统一状态徽章，统一各页列表里"启用/禁用/待处理/失败"等状态标签的视觉。
 *
 * @param tone 语义色调。
 * @param icon 左侧图标，可选。
 */
export function AdminStatusBadge({
  tone,
  icon: Icon,
  children,
}: {
  tone: AdminBadgeTone;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeToneClass[tone]}`}
    >
      {Icon ? <Icon size={11} /> : null}
      {children}
    </span>
  );
}
