'use client';

import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  error?: Error;
}

interface Props {
  children: React.ReactNode;
}

/**
 * 顶级错误边界：拦截子树渲染异常，避免单一组件抛错导致整页白屏。
 * 提供"重试"按钮重新挂载子树；用户也可以选择刷新页面或返回首页。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    if (process.env.NODE_ENV === 'development') {
      console.error('ErrorBoundary caught:', error, errorInfo);
    }
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      const debugMessage =
        process.env.NODE_ENV === 'development'
          ? this.state.error?.message
          : null;

      return (
        <div className="min-h-[60vh] flex items-center justify-center px-6">
          <div className="max-w-md w-full text-center space-y-4">
            <AlertTriangle
              size={36}
              className="text-error mx-auto"
            />
            <h1 className="text-base font-semibold text-ink">
              页面渲染出错
            </h1>
            <p className="text-[13px] text-muted">
              页面遇到异常，请刷新页面后重试；如果仍然失败，请稍后再试。
            </p>
            {debugMessage ? (
              <p className="text-[12px] text-muted break-all">
                开发态调试信息：{debugMessage}
              </p>
            ) : null}
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                onClick={this.handleRetry}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium border border-hairline bg-surface-card text-ink hover:bg-surface-cream-strong transition-colors cursor-pointer"
              >
                <RotateCcw size={13} />
                重试
              </button>
              <button
                onClick={() => window.location.reload()}
                className="h-9 px-4 rounded-lg text-[13px] font-medium bg-primary text-black hover:opacity-90 transition-opacity cursor-pointer"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
