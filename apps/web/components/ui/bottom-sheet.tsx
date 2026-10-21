'use client';

import {
  ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * 全局 body scroll lock 引用计数。
 * 多个 BottomSheet 同时打开时（例如 BundleForm 上再弹 confirm），
 * 只有所有 sheet 都关闭才还原 body overflow。
 */
let bodyLockCount = 0;
let savedBodyOverflow: string | null = null;

function lockBody() {
  if (typeof document === 'undefined') return;
  if (bodyLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyLockCount += 1;
}

function unlockBody() {
  if (typeof document === 'undefined') return;
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0 && savedBodyOverflow !== null) {
    document.body.style.overflow = savedBodyOverflow;
    savedBodyOverflow = null;
  }
}

export type BottomSheetVariant = 'sheet' | 'fullscreen-sheet';
export type BottomSheetSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<BottomSheetSize, string> = {
  sm: 'sm:max-w-[400px]',
  md: 'sm:max-w-[560px]',
  lg: 'sm:max-w-[800px]',
};

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  variant?: BottomSheetVariant;
  size?: BottomSheetSize;
  title?: ReactNode;
  titleExtra?: ReactNode;
  footer?: ReactNode;
  closeOnOverlay?: boolean;
  zIndex?: number;
  'aria-label'?: string;
  hideCloseButton?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  fillHeight?: boolean;
  children: ReactNode;
}

export function BottomSheet({
  open,
  onClose,
  variant = 'sheet',
  size = 'md',
  title,
  titleExtra,
  footer,
  closeOnOverlay = true,
  zIndex = 100,
  hideCloseButton = false,
  initialFocusRef,
  fillHeight = false,
  children,
  ...rest
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [dragY, setDragY] = useState(0);
  const [mounted, setMounted] = useState(false);
  const dragStartY = useRef(0);
  const isDragging = useRef(false);
  const DISMISS_THRESHOLD = 0.3;

  useEffect(() => {
    setMounted(true);
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    dragStartY.current = e.touches[0].clientY;
    isDragging.current = true;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging.current) return;
    const dy = e.touches[0].clientY - dragStartY.current;
    if (dy < 0) return;
    setDragY(dy);
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const panel = panelRef.current;
    if (!panel) {
      setDragY(0);
      return;
    }
    const height = panel.offsetHeight;
    if (dragY > height * DISMISS_THRESHOLD) {
      setDragY(height);
      setTimeout(onClose, 200);
    } else {
      setDragY(0);
    }
  }, [dragY, onClose]);

  // body scroll lock
  useEffect(() => {
    if (!open) return;
    lockBody();
    return () => unlockBody();
  }, [open]);

  // ESC 关闭 + focus trap
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        trapTab(e);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 开启时聚焦 panel 内第一个可聚焦元素，关闭时还原
  useLayoutEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = getFocusableElements(panel);
    const target =
      initialFocusRef?.current ||
      focusables.find((el) => el.hasAttribute('autofocus')) ||
      focusables[0] ||
      panel;
    // 下一帧聚焦，等动画/渲染稳定
    requestAnimationFrame(() => target?.focus?.({ preventScroll: true }));

    return () => {
      previouslyFocusedRef.current?.focus?.({ preventScroll: true });
    };
  }, [open, initialFocusRef]);

  if (!mounted || !open) return null;

  const isFullscreen = variant === 'fullscreen-sheet';

  // 移动端：贴底 + dvh（软键盘弹起容器自动收缩）
  // 桌面端：居中 + max-w 按 size 切换
  const containerHeightClass = isFullscreen
    ? fillHeight
      ? 'h-[100dvh] sm:h-[90dvh]'
      : 'h-[100dvh] sm:h-auto sm:max-h-[90dvh]'
    : 'max-h-[92dvh] sm:max-h-[85dvh]';
  const panelRadiusClass = isFullscreen
    ? 'rounded-none sm:rounded-3xl'
    : 'rounded-t-3xl sm:rounded-3xl';
  // 部分移动端 WebView 不会稳定上报 safe-area，给全屏弹层顶部控制区保留最小可触达距离。
  const mobileDragHandleStyle = {
    paddingTop: isFullscreen
      ? 'max(calc(env(safe-area-inset-top, 0px) + 0.5rem), 2rem)'
      : 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
  };

  const sheet = (
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center sm:p-4"
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-label={rest['aria-label']}
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-dialog-overlay"
        onClick={() => closeOnOverlay && onClose()}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={`relative w-full ${SIZE_CLASS[size]} ${containerHeightClass} ${panelRadiusClass} bg-surface-raised border border-hairline shadow-2xl overflow-hidden flex flex-col animate-bottom-sheet-slide-up sm:animate-bottom-sheet-center-in`}
        style={{
          transform: `translateY(${dragY}px)`,
          transition: isDragging.current ? 'none' : 'transform 0.3s ease-out',
        }}
      >
        {/* 移动端 drag handle 指示条 */}
        <div
          className="lg:hidden flex justify-center pb-1"
          style={mobileDragHandleStyle}
        >
          <div className="w-10 h-1 rounded-full bg-hairline" />
        </div>

        {/* 标题栏 */}
        {(title || !hideCloseButton) && (
          <div className="shrink-0">
            <div className="px-4 sm:px-6 pt-2 sm:pt-5 pb-3 sm:pb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {title && (
                  <h3 className="text-[15px] font-semibold tracking-tight truncate">
                    {title}
                  </h3>
                )}
                {titleExtra && <div className="shrink-0">{titleExtra}</div>}
              </div>
              {!hideCloseButton && (
                <button
                  onClick={onClose}
                  className="w-10 h-10 sm:w-9 sm:h-9 flex items-center justify-center rounded-xl text-muted hover:text-ink active:bg-surface-cream-strong sm:hover:bg-surface-cream-strong transition-all duration-200 cursor-pointer shrink-0"
                  aria-label="关闭"
                >
                  <X size={20} className="sm:w-[18px] sm:h-[18px]" />
                </button>
              )}
            </div>
            <div className="h-px bg-gradient-to-r from-transparent via-hairline to-transparent" />
          </div>
        )}

        {/* 内容区（flex-1 + 滚动，高度由外层 dvh 托管） */}
        <div
          data-artifact-viewport
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {children}
        </div>

        {/* 粘底 footer - 自带 safe-area */}
        {footer && (
          <div
            className="shrink-0 bg-surface-card border-t border-hairline"
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  // 内部再打开 BottomSheet 时需要脱离父级 transform / overflow，避免移动端被主面板裁切。
  return createPortal(sheet, document.body);
}

// ─────────────────────────────────────────────────────────────
// Focus trap 辅助
// ─────────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null, // 过滤掉被 display:none 隐藏的
  );
}

/** Only the topmost dialog owns keyboard focus when sheets are nested. */
function trapTab(e: KeyboardEvent) {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  const topPanel = dialogs[dialogs.length - 1];
  if (!topPanel) return;
  const focusables = getFocusableElements(topPanel);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;

  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
