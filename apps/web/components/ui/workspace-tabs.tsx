'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';

interface WorkspaceTab {
  id: string;
  label: string;
  icon: LucideIcon;
  content: ReactNode;
}

export function WorkspaceTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly [WorkspaceTab, ...WorkspaceTab[]];
}) {
  const id = useId();
  const [activeTab, setActiveTab] = useState(tabs[0].id);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash.slice(1);
      const nextTab = tabs.find((tab) => tab.id === hash);
      if (nextTab) {
        setActiveTab(nextTab.id);
      } else if (!hash) {
        setActiveTab(tabs[0].id);
      }
    };

    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    window.addEventListener('popstate', syncFromHash);
    return () => {
      window.removeEventListener('hashchange', syncFromHash);
      window.removeEventListener('popstate', syncFromHash);
    };
  }, [tabs]);

  function selectTab(tabId: string) {
    setActiveTab(tabId);
    const url = new URL(window.location.href);
    url.hash = tabId;
    window.history.replaceState(window.history.state, '', url);
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectTab(tabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <div>
      <div className="sticky top-14 z-20 -mx-1 mb-4 bg-canvas/95 px-1 py-2 backdrop-blur-sm lg:top-0">
        <div
          role="tablist"
          aria-label={label}
          className="flex gap-1 overflow-x-auto rounded-xl border border-hairline bg-surface-card p-1"
        >
          {tabs.map(({ id: tabId, label: tabLabel, icon: Icon }, index) => {
            const active = activeTab === tabId;
            return (
              <button
                key={tabId}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${tabId}`}
                aria-controls={`${id}-panel-${tabId}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => selectTab(tabId)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={`flex min-h-11 flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                  active
                    ? 'bg-surface-raised text-ink shadow-sm'
                    : 'text-muted hover:bg-surface-cream-strong hover:text-ink'
                }`}
              >
                <Icon
                  size={14}
                  aria-hidden="true"
                  className={`shrink-0 ${active ? 'text-primary' : ''}`}
                />
                {tabLabel}
              </button>
            );
          })}
        </div>
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${id}-panel-${tab.id}`}
          aria-labelledby={`${id}-tab-${tab.id}`}
          hidden={activeTab !== tab.id}
          tabIndex={0}
          className="space-y-3.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          {/* Keep panels mounted so switching tabs preserves form drafts and in-flight actions. */}
          {tab.content}
        </div>
      ))}
    </div>
  );
}
