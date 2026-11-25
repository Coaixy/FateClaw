'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface State {
  hasError: boolean;
}

export class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode; fallbackTitle?: string },
  State
> {
  constructor(props: { children: React.ReactNode; fallbackTitle?: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Chart rendering error:', error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-8 px-6 rounded-xl border border-hairline bg-surface-card">
          <AlertTriangle size={28} className="text-error mb-2" />
          <h3 className="text-[13px] font-medium text-ink mb-1">
            {this.props.fallbackTitle ?? '盘面渲染失败'}
          </h3>
          <p className="text-[11px] text-muted text-center">
            盘面数据格式异常，仅可查看对话内容
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
