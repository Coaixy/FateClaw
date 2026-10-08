'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, Save } from 'lucide-react';
import {
  admin,
  formatAdminErrorMessage,
  type AdminModelSettingsUpdate,
  type AdminSystemConfigOverview,
} from '@/lib/admin-api';

const EMPTY_CONFIG: AdminModelSettingsUpdate = {
  pi_api: 'openai-completions',
  base_url: null,
  model_name: '',
  context_window_tokens: null,
  thinking_level: 'medium',
  input_token_price_per_million_coins: 0,
  output_token_price_per_million_coins: 0,
};

function configFromOverview(
  overview: AdminSystemConfigOverview,
): AdminModelSettingsUpdate {
  const model = overview.model;
  return {
    pi_api: model?.pi_api ?? EMPTY_CONFIG.pi_api,
    base_url: model?.base_url ?? null,
    model_name: model?.model_name ?? '',
    auth_mode: model?.auth_mode,
    context_window_tokens: model?.context_window_tokens ?? null,
    thinking_level: overview.thinking_level,
    input_token_price_per_million_coins:
      model?.input_token_price_per_million_coins ?? 0,
    output_token_price_per_million_coins:
      model?.output_token_price_per_million_coins ?? 0,
  };
}

const FIELD_CLASS =
  'h-10 w-full rounded-lg border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-primary disabled:opacity-60';

export default function AdminModelConfigPage() {
  const [overview, setOverview] = useState<AdminSystemConfigOverview | null>(
    null,
  );
  const [draft, setDraft] = useState<AdminModelSettingsUpdate>(EMPTY_CONFIG);
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSaved(false);
    try {
      const data = await admin.systemConfig();
      setOverview(data);
      setDraft(configFromOverview(data));
      setSecret('');
    } catch (err) {
      setError(formatAdminErrorMessage(err, 'Could not load model configuration'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patchDraft(patch: Partial<AdminModelSettingsUpdate>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setSaved(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading || !overview) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const data = await admin.updateModelSettings({
        ...draft,
        model_name: draft.model_name.trim(),
        base_url: draft.base_url?.trim() || null,
        ...(secret.trim() ? { api_key: secret.trim() } : {}),
      });
      setOverview(data);
      setDraft(configFromOverview(data));
      setSecret('');
      setSaved(true);
    } catch (err) {
      setError(formatAdminErrorMessage(err, 'Could not save model configuration'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Bot size={18} /> Model configuration
          </h2>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            One official model and thinking level for all users.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || saving}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-hairline px-3 text-[13px] text-muted hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 bg-error/8 px-4 py-3 text-[13px] text-error"
        >
          {error}
        </p>
      )}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
        </div>
      ) : (
        overview && (
          <form
            onSubmit={(event) => void save(event)}
            className="rounded-xl border border-hairline bg-surface-card"
          >
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
              <h3 className="text-sm font-semibold">Official model</h3>
              <span className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted">
                {overview.model?.has_secret ? 'Configured' : 'Not configured'}
              </span>
            </div>
            <fieldset disabled={saving} className="space-y-5 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5 text-[12px] text-muted">
                  <span className="block">Protocol</span>
                  <select
                    className={FIELD_CLASS}
                    value={draft.pi_api}
                    onChange={(event) => {
                      const piApi = event.target
                        .value as AdminModelSettingsUpdate['pi_api'];
                      patchDraft({
                        pi_api: piApi,
                        auth_mode:
                          piApi === 'anthropic-messages'
                            ? 'anthropic_api_key'
                            : piApi === 'google-generative-ai'
                              ? 'gemini_api_key'
                              : 'openai_api_key',
                      });
                    }}
                  >
                    <option value="openai-completions">OpenAI Chat Completions</option>
                    <option value="openai-responses">
                      OpenAI Responses
                    </option>
                    <option value="anthropic-messages">
                      Anthropic Messages
                    </option>
                    <option value="google-generative-ai">Google Gemini</option>
                  </select>
                </label>
                <label className="space-y-1.5 text-[12px] text-muted">
                  <span className="block">Model</span>
                  <input
                    className={FIELD_CLASS}
                    required
                    maxLength={120}
                    value={draft.model_name}
                    placeholder="Model ID"
                    onChange={(event) =>
                      patchDraft({ model_name: event.target.value })
                    }
                  />
                </label>
              </div>
              <label className="block space-y-1.5 text-[12px] text-muted">
                <span className="block">Base URL</span>
                <input
                  className={FIELD_CLASS}
                  type="url"
                  maxLength={500}
                  value={draft.base_url ?? ''}
                  placeholder="Leave blank to use the provider default"
                  onChange={(event) =>
                    patchDraft({ base_url: event.target.value || null })
                  }
                />
              </label>
              <label className="block space-y-1.5 text-[12px] text-muted">
                <span className="block">API key</span>
                <input
                  className={FIELD_CLASS}
                  type="password"
                  autoComplete="new-password"
                  required={!overview.model?.has_secret}
                  maxLength={2000}
                  value={secret}
                  placeholder={
                    overview.model?.has_secret
                      ? 'Leave blank to keep the saved key'
                      : 'Enter an API key'
                  }
                  onChange={(event) => {
                    setSecret(event.target.value);
                    setSaved(false);
                  }}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5 text-[12px] text-muted">
                  <span className="block">Thinking level</span>
                  <select
                    className={FIELD_CLASS}
                    value={draft.thinking_level}
                    onChange={(event) =>
                      patchDraft({
                        thinking_level: event.target
                          .value as AdminModelSettingsUpdate['thinking_level'],
                      })
                    }
                  >
                    <option value="off">Off</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">Extra high</option>
                  </select>
                </label>
                {draft.pi_api === 'anthropic-messages' && (
                  <label className="space-y-1.5 text-[12px] text-muted">
                    <span className="block">Authentication</span>
                    <select
                      className={FIELD_CLASS}
                      value={draft.auth_mode ?? 'anthropic_api_key'}
                      onChange={(event) =>
                        patchDraft({
                          auth_mode: event.target
                            .value as AdminModelSettingsUpdate['auth_mode'],
                        })
                      }
                    >
                      <option value="anthropic_api_key">API key</option>
                      <option value="claude_code_oauth_token">
                        Claude Code OAuth token
                      </option>
                    </select>
                  </label>
                )}
              </div>
              <details className="rounded-lg border border-hairline px-4 py-3">
                <summary className="cursor-pointer text-[12px] text-muted">
                  Token pricing and context window
                </summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1.5 text-[12px] text-muted">
                    <span className="block">Input coins / million tokens</span>
                    <input
                      className={FIELD_CLASS}
                      type="number"
                      min={0}
                      max={1000000}
                      step={1}
                      required
                      value={draft.input_token_price_per_million_coins}
                      onChange={(event) =>
                        patchDraft({
                          input_token_price_per_million_coins: Number(
                            event.target.value,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="space-y-1.5 text-[12px] text-muted">
                    <span className="block">Output coins / million tokens</span>
                    <input
                      className={FIELD_CLASS}
                      type="number"
                      min={0}
                      max={1000000}
                      step={1}
                      required
                      value={draft.output_token_price_per_million_coins}
                      onChange={(event) =>
                        patchDraft({
                          output_token_price_per_million_coins: Number(
                            event.target.value,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="space-y-1.5 text-[12px] text-muted sm:col-span-2">
                    <span className="block">Context window (tokens)</span>
                    <input
                      className={FIELD_CLASS}
                      type="number"
                      min={0}
                      max={2000000}
                      step={1}
                      value={draft.context_window_tokens ?? 0}
                      onChange={(event) =>
                        patchDraft({
                          context_window_tokens:
                            Number(event.target.value) || null,
                        })
                      }
                    />
                    <span className="block">Use 0 for automatic detection.</span>
                  </label>
                </div>
              </details>
            </fieldset>
            <div className="flex items-center justify-end gap-3 border-t border-hairline px-5 py-4">
              {saved && (
                <span role="status" className="text-[12px] text-success">
                  Configuration saved
                </span>
              )}
              <button
                type="submit"
                disabled={saving || !draft.model_name.trim()}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:bg-primary-active disabled:opacity-50"
              >
                <Save size={14} /> {saving ? 'Saving…' : 'Save configuration'}
              </button>
            </div>
          </form>
        )
      )}
    </div>
  );
}
