'use client';

import { useEffect, useReducer, useState } from 'react';
import { FileText, Loader2, RotateCcw, Save } from 'lucide-react';

import { accountsApi } from '@/features/accounts/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

/**
 * 平台默认话术稿骨架。
 *
 * 须与 agent-runtime 的 DEFAULT_GUASHI_SCRIPT_SKELETON(resource-loader.ts)保持一致;
 * agent-runtime 不引用 @fateclaw/contracts(无 paths 解析),故前后端各自维护一份。
 */
const DEFAULT_GUASHI_SCRIPT_TEMPLATE = `## 核心论断 —— 先给客户最关心的一句话结论
## 分项解读 —— 按事业/财运/感情/健康等相关维度逐项展开
## 时机提示 —— 关键时间点（流年/流月等）
## 给客户的建议 —— 可落地的行动建议
## ⚠分寸提示 —— 仅供卦师参考：哪些话不宜对客户说死、客户可能追问什么；此节是给卦师的内部提示，不要写成直接对客户说的话`;

/**
 * 话术稿模板的异步状态：加载中、保存中与错误提示。
 *
 * 这三者都围绕同一组远程读写流转，故合并为 reducer；编辑内容本身仍是独立 state。
 */
interface ScriptTemplateStatus {
  loading: boolean;
  saving: boolean;
  error: string;
}

type ScriptTemplateStatusAction =
  | { type: 'loadStart' }
  | { type: 'loadEnd' }
  | { type: 'saveStart' }
  | { type: 'saveEnd' }
  | { type: 'error'; message: string };

function scriptTemplateStatusReducer(
  state: ScriptTemplateStatus,
  action: ScriptTemplateStatusAction,
): ScriptTemplateStatus {
  switch (action.type) {
    case 'loadStart':
      return { ...state, loading: true, error: '' };
    case 'loadEnd':
      return { ...state, loading: false };
    case 'saveStart':
      return { ...state, saving: true, error: '' };
    case 'saveEnd':
      return { ...state, saving: false };
    case 'error':
      return { ...state, error: action.message };
  }
}

/**
 * 用户级话术稿模板编辑器。
 *
 * 卦师在此自定义 AI 解读的分节骨架(Markdown ## 章节);留空则解读时回退平台默认骨架。
 * 标题里带「⚠」或「[仅卦师]」标记的章节会被前端识别为仅卦师可见,导出给客户时自动剔除。
 */
export function GuashiScriptTemplateCard() {
  const { toast } = useToast();
  const { formatNumber, t } = useI18n();
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [status, statusDispatch] = useReducer(scriptTemplateStatusReducer, {
    loading: true,
    saving: false,
    error: '',
  });
  const { loading, saving, error } = status;
  const dirty = content !== savedContent;

  useEffect(() => {
    let alive = true;

    async function loadTemplate() {
      statusDispatch({ type: 'loadStart' });
      try {
        const result = await accountsApi.getUserGuashiScriptTemplate();
        if (!alive) return;
        setContent(result.content);
        setSavedContent(result.content);
      } catch (err) {
        if (!alive) return;
        statusDispatch({
          type: 'error',
          message:
            err instanceof Error ? err.message : t('pages.persona.loadFailed'),
        });
      } finally {
        if (alive) statusDispatch({ type: 'loadEnd' });
      }
    }

    void loadTemplate();
    return () => {
      alive = false;
    };
  }, []);

  const saveTemplate = async () => {
    if (!dirty || saving) return;
    statusDispatch({ type: 'saveStart' });
    try {
      await accountsApi.updateUserGuashiScriptTemplate(content);
      setSavedContent(content);
      toast('success', t('pages.persona.saved'));
    } catch (err) {
      statusDispatch({
        type: 'error',
        message:
          err instanceof Error ? err.message : t('pages.persona.saveFailed'),
      });
    } finally {
      statusDispatch({ type: 'saveEnd' });
    }
  };

  // 填入默认骨架供卦师在其基础上修改;不直接保存,留给卦师确认后再部署。
  const fillDefault = () => {
    if (loading || saving) return;
    setContent(DEFAULT_GUASHI_SCRIPT_TEMPLATE);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <FileText size={15} className="text-primary" />
            {t('pages.persona.scriptTitle')}
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            {t('pages.persona.scriptDescription')}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <button
            type="button"
            onClick={fillDefault}
            disabled={loading || saving}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-hairline bg-surface-card/70 px-3 text-[12px] font-medium text-ink transition-colors hover:border-primary/45 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <RotateCcw size={14} className="text-muted" />
            {t('pages.persona.scriptFillDefault')}
          </button>
          <button
            type="button"
            onClick={() => void saveTemplate()}
            disabled={!dirty || loading || saving}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            {t('pages.persona.deploy')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-[220px] rounded-xl border border-hairline/50 bg-surface-card/50 animate-pulse" />
      ) : (
        <div className="relative">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="h-[220px] w-full resize-y rounded-xl border border-hairline bg-surface-card/70 px-3.5 py-3 pr-20 font-mono text-[12px] leading-[1.7] text-ink transition-colors focus:border-primary/60 focus:bg-surface-card/90 focus:outline-none"
            placeholder={t('pages.persona.scriptPlaceholder')}
            spellCheck={false}
          />
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-hairline/60 bg-canvas/80 px-1.5 py-0.5 font-mono text-[10px] text-muted">
            markdown
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1 text-[11px] text-muted sm:flex-row sm:items-center sm:justify-between">
        <span className={error ? 'text-error' : ''}>
          {error ||
            (dirty ? t('pages.persona.dirty') : t('pages.persona.scriptHint'))}
        </span>
        <span className="font-mono">
          {t('pages.persona.chars', { count: formatNumber(content.length) })}
        </span>
      </div>
    </div>
  );
}
