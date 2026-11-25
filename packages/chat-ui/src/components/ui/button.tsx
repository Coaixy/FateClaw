'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'secondary-on-dark' | 'danger' | 'ghost' | 'text-link';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variantStyles: Record<Variant, string> = {
  // 主/次按钮走 tactile 物理质感(内高光+压边+投影);primary 的渐变由 btn-tactile-primary 提供,
  // 不叠加 bg-primary(会被渐变覆盖)。
  primary:
    'btn-tactile-primary text-on-primary',
  secondary:
    'btn-tactile bg-surface-raised text-ink border border-hairline hover:border-primary/40',
  'secondary-on-dark':
    'bg-surface-dark-elevated text-on-dark border border-hairline hover:border-primary/40',
  danger:
    'bg-error/10 text-error border border-error/20 hover:bg-error/20',
  ghost:
    'text-muted hover:text-ink hover:bg-surface-card',
  'text-link':
    'text-primary hover:underline bg-transparent',
};

const sizeStyles: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12px] gap-1 rounded-lg',
  md: 'h-10 px-5 text-[14px] gap-1.5 rounded-lg',
  lg: 'h-12 px-6 text-[15px] gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, icon, children, className = '', disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`inline-flex items-center justify-center font-medium transition-all duration-150 cursor-pointer active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        {loading ? <Loader2 size={size === 'sm' ? 12 : 14} className="animate-spin shrink-0" /> : icon ? <span className="shrink-0">{icon}</span> : null}
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
