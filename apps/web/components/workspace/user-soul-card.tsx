'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save, Sparkles } from 'lucide-react';

import { accountsApi } from '@/features/accounts/api';
import { useToast } from '@/lib/use-toast';

/**
 * 用户级 Soul 编辑器。
 *
 * 这份自定义人格统一注入站内 AI Chat 和微信 BOT 的 Pi Runtime。
 */
export function UserSoulCard() {
  const { toast } = useToast();
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = content !== savedContent;

  useEffect(() => {
    let alive = true;

    async function loadSoul() {
      setLoading(true);
      setError('');
      try {
        const result = await accountsApi.getUserSoul();
        if (!alive) return;
        setContent(result.content);
        setSavedContent(result.content);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : '加载自定义人格失败');
      } finally {
        if (alive) setLoading(false);
      }
    }

    void loadSoul();
    return () => {
      alive = false;
    };
  }, []);

  const saveSoul = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError('');
    try {
      await accountsApi.updateUserSoul(content);
      setSavedContent(content);
      toast('success', '自定义人格已保存并注入运行时');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存自定义人格失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <Sparkles size={15} className="text-primary" />
            自定义人格 Soul
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            统一注入站内 AI Chat 和微信 BOT 的 Pi Runtime。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void saveSoul()}
          disabled={!dirty || loading || saving}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          部署至运行时
        </button>
      </div>

      {loading ? (
        <div className="h-[220px] rounded-xl border border-hairline/50 bg-surface-card/50 animate-pulse" />
      ) : (
        <div className="relative">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="h-[220px] w-full resize-y rounded-xl border border-hairline bg-surface-card/70 px-3.5 py-3 pr-20 font-mono text-[12px] leading-[1.7] text-ink transition-colors focus:border-primary/60 focus:bg-surface-card/90 focus:outline-none"
            placeholder="输入自定义人格、沟通风格、禁忌、固定背景或长期记忆..."
            spellCheck={false}
          />
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-hairline/60 bg-canvas/80 px-1.5 py-0.5 font-mono text-[10px] text-muted">
            markdown
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1 text-[11px] text-muted sm:flex-row sm:items-center sm:justify-between">
        <span className={error ? 'text-error' : ''}>
          {error || (dirty ? '有未保存修改' : '已同步')}
        </span>
        <span className="font-mono">{content.length} chars</span>
      </div>
    </div>
  );
}
