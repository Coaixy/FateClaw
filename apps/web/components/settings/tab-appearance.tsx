'use client';

import { Monitor, Moon, Palette, Sun } from 'lucide-react';

import { ThemeMode, useTheme } from '@/lib/use-theme';

export function TabAppearance() {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  const options = [
    { mode: 'system' as ThemeMode, icon: Monitor, label: '跟随系统', desc: '自动匹配系统外观' },
    { mode: 'light' as ThemeMode, icon: Sun, label: '浅色模式', desc: '明亮的界面主题' },
    { mode: 'dark' as ThemeMode, icon: Moon, label: '深色模式', desc: '护眼暗色主题' },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-hairline">
      <div className="border-b border-hairline bg-surface-card px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Palette size={14} className="text-muted" />
          <div>
            <p className="text-[12px] font-medium">外观偏好</p>
            <p className="text-[10px] text-muted">选择你在工作台里的主题展示方式</p>
          </div>
        </div>
      </div>

      <div className="bg-surface-card px-4 py-3">
        <div className="overflow-hidden rounded-xl border border-hairline bg-canvas/36">
          {options.map(({ mode, icon: Icon, label, desc }, i) => (
            <button
              key={mode}
              onClick={() => setThemeMode(mode)}
              className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors cursor-pointer ${
                i > 0 ? 'border-t border-hairline' : ''
              } ${
                themeMode === mode
                  ? 'bg-[color-mix(in_srgb,var(--color-primary)_9%,var(--color-surface-card))]'
                  : 'hover:bg-surface-cream-strong'
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-[28px] w-[28px] items-center justify-center rounded-lg ${
                    themeMode === mode
                      ? 'bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]'
                      : 'bg-surface-card/90'
                  }`}
                >
                  <Icon
                    size={13}
                    className={
                      themeMode === mode ? 'text-primary' : 'text-muted'
                    }
                  />
                </div>
                <div className="text-left">
                  <p className="text-[11px] font-medium">{label}</p>
                  <p className="text-[10px] text-muted">{desc}</p>
                </div>
              </div>
              <div className="flex h-4 w-4 items-center justify-center rounded-full border border-hairline">
                <div
                  className={`h-2 w-2 rounded-full transition-colors ${
                    themeMode === mode ? 'bg-primary' : 'bg-transparent'
                  }`}
                />
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
