'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Bot, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
  admin,
  formatAdminErrorMessage,
  type AdminModelSettingsUpdate,
  type AdminSystemConfigOverview,
} from '@/lib/admin-api';

type NodeInput = AdminModelSettingsUpdate['nodes'][number];
type DraftNode = NodeInput & {
  isPrimary: boolean;
  clientKey: string;
  hasSecret: boolean;
  failureCount: number;
  cooldownUntil: string | null;
};
type Draft = Omit<AdminModelSettingsUpdate, 'nodes'> & { nodes: DraftNode[] };

const EMPTY_CONFIG: Draft = {
  display_name: '官方模型池',
  thinking_level: 'medium',
  input_token_price_per_million_coins: 0,
  output_token_price_per_million_coins: 0,
  nodes: [],
};
const FIELD_CLASS =
  'h-10 w-full rounded-lg border border-hairline bg-canvas px-3 text-[13px] text-ink outline-none focus:border-primary disabled:opacity-60';
const LABEL_CLASS = 'block space-y-1.5 text-[12px] text-muted';

function newNode(isPrimary = false): DraftNode {
  return {
    isPrimary,
    clientKey: crypto.randomUUID(),
    display_name: '',
    model_name: '',
    pi_api: 'openai-completions',
    base_url: null,
    context_window_tokens: null,
    enabled: true,
    weight: 1,
    api_key: '',
    hasSecret: false,
    failureCount: 0,
    cooldownUntil: null,
  };
}

function configFromOverview(overview: AdminSystemConfigOverview): Draft {
  return {
    display_name: overview.model.display_name,
    thinking_level: overview.thinking_level,
    input_token_price_per_million_coins:
      overview.model.input_token_price_per_million_coins,
    output_token_price_per_million_coins:
      overview.model.output_token_price_per_million_coins,
    nodes: overview.nodes.length
      ? [...overview.nodes]
          .sort(
            (left, right) => Number(right.is_primary) - Number(left.is_primary),
          )
          .map((node) => ({
            isPrimary: node.is_primary,
            id: node.id,
            clientKey: node.id,
            display_name: node.display_name,
            model_name: node.model_name,
            pi_api: node.pi_api,
            base_url: node.base_url,
            context_window_tokens: node.context_window_tokens,
            auth_mode: node.auth_mode,
            enabled: node.enabled,
            weight: node.weight,
            api_key: '',
            hasSecret: node.has_secret,
            failureCount: node.failure_count,
            cooldownUntil: node.cooldown_until,
          }))
      : [newNode(true)],
  };
}

function nodeStatus(node: DraftNode): { label: string; color: string } {
  if (!node.enabled) return { label: '已停用', color: 'text-muted' };
  if (!node.hasSecret && !node.api_key?.trim())
    return { label: '未配密钥', color: 'text-warning' };
  if (node.cooldownUntil)
    return {
      label:
        new Date(node.cooldownUntil).getTime() > Date.now()
          ? '故障冷却中'
          : '等待恢复探测',
      color: 'text-warning',
    };
  return { label: '可用', color: 'text-success' };
}

export default function AdminModelConfigPage() {
  const [draft, setDraft] = useState<Draft>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSaved(false);
    try {
      setDraft(configFromOverview(await admin.systemConfig()));
    } catch (err) {
      setError(formatAdminErrorMessage(err, '加载模型池失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patchDraft(patch: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setSaved(false);
  }
  function patchNode(clientKey: string, patch: Partial<DraftNode>) {
    setDraft((previous) => ({
      ...previous,
      nodes: previous.nodes.map((node) =>
        node.clientKey === clientKey ? { ...node, ...patch } : node,
      ),
    }));
    setSaved(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const data = await admin.updateModelSettings({
        display_name: draft.display_name.trim(),
        thinking_level: draft.thinking_level,
        input_token_price_per_million_coins:
          draft.input_token_price_per_million_coins,
        output_token_price_per_million_coins:
          draft.output_token_price_per_million_coins,
        nodes: draft.nodes.map((node) => ({
          id: node.id,
          display_name: node.display_name.trim(),
          pi_api: node.pi_api,
          model_name: node.model_name.trim(),
          base_url: node.base_url?.trim() || null,
          context_window_tokens: node.context_window_tokens,
          auth_mode: node.auth_mode,
          enabled: node.enabled,
          weight: node.weight,
          ...(node.api_key?.trim() ? { api_key: node.api_key.trim() } : {}),
        })),
      });
      setDraft(configFromOverview(data));
      setSaved(true);
    } catch (err) {
      setError(formatAdminErrorMessage(err, '保存模型池失败'));
    } finally {
      setSaving(false);
    }
  }

  const enabledNodes = draft.nodes.filter((node) => node.enabled);
  const totalWeight = enabledNodes.reduce((sum, node) => sum + node.weight, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Bot size={18} /> 官方模型池
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
            多个模型共同供应，按权重分摊调用；供应商故障时自动切换可用节点。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || saving}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-hairline px-3 text-[13px] text-muted hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
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
        <form onSubmit={(event) => void save(event)} className="space-y-5">
          <fieldset
            disabled={saving}
            className="rounded-xl border border-hairline bg-surface-card p-5"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">统一入口与价格</h3>
              <span className="text-[12px] text-muted">
                {enabledNodes.length} / {draft.nodes.length} 个节点启用
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={LABEL_CLASS}>
                <span className="block">对外名称</span>
                <input
                  className={FIELD_CLASS}
                  required
                  maxLength={120}
                  value={draft.display_name}
                  onChange={(event) =>
                    patchDraft({ display_name: event.target.value })
                  }
                />
              </label>
              <label className={LABEL_CLASS}>
                <span className="block">统一思考等级</span>
                <select
                  className={FIELD_CLASS}
                  value={draft.thinking_level}
                  onChange={(event) =>
                    patchDraft({
                      thinking_level: event.target
                        .value as Draft['thinking_level'],
                    })
                  }
                >
                  <option value="off">关闭</option>
                  <option value="minimal">最低</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="xhigh">最高</option>
                </select>
              </label>
              <label className={LABEL_CLASS}>
                <span className="block">输入价格（积分 / 百万 Token）</span>
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
              <label className={LABEL_CLASS}>
                <span className="block">输出价格（积分 / 百万 Token）</span>
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
            </div>
            <p className="mt-3 text-[12px] leading-6 text-muted">
              用户统一按以上价格计费。上下文容量按启用节点的最小值计算；混用模型时，回答能力可能有所不同。
            </p>
          </fieldset>
          <div>
            <h3 className="text-sm font-semibold">主节点</h3>
            <p className="mt-1 text-[12px] text-muted">
              主节点固定保留，配置可以编辑；与子节点按权重分摊调用。
            </p>
          </div>
          <div className="space-y-4">
            {draft.nodes.map((node, index) => {
              const status = nodeStatus(node);
              return (
                <Fragment key={node.clientKey}>
                  <fieldset
                    disabled={saving}
                    className={`overflow-hidden rounded-xl border bg-surface-card ${node.isPrimary ? 'border-primary/35' : 'border-hairline'}`}
                  >
                    <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium">
                          {node.display_name ||
                            (node.isPrimary ? '主节点' : `子节点 ${index}`)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${node.isPrimary ? 'bg-primary/10 text-primary' : 'bg-canvas text-muted'}`}
                        >
                          {node.isPrimary ? '主节点' : '子节点'}
                        </span>
                        <span
                          className={`rounded-full bg-canvas px-2 py-0.5 text-[11px] ${status.color}`}
                        >
                          {status.label}
                        </span>
                        {node.enabled && totalWeight > 0 && (
                          <span className="text-[11px] text-muted">
                            预计分流{' '}
                            {Math.round((node.weight / totalWeight) * 100)}%
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-4">
                        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={node.enabled}
                            onChange={(event) =>
                              patchNode(node.clientKey, {
                                enabled: event.target.checked,
                              })
                            }
                          />{' '}
                          启用
                        </label>
                        {!node.isPrimary && (
                          <button
                            type="button"
                            aria-label={`移除${node.display_name || `子节点 ${index}`}`}
                            title="移除子节点"
                            onClick={() =>
                              patchDraft({
                                nodes: draft.nodes.filter(
                                  (entry) => entry.clientKey !== node.clientKey,
                                ),
                              })
                            }
                            className="rounded-md p-1.5 text-muted hover:bg-error/10 hover:text-error disabled:opacity-30"
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="grid gap-4 p-5 sm:grid-cols-2">
                      <label className={LABEL_CLASS}>
                        <span className="block">节点名称</span>
                        <input
                          className={FIELD_CLASS}
                          required
                          maxLength={120}
                          value={node.display_name}
                          placeholder="例如：供应商 A"
                          onChange={(event) =>
                            patchNode(node.clientKey, {
                              display_name: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className={LABEL_CLASS}>
                        <span className="block">权重</span>
                        <input
                          className={FIELD_CLASS}
                          type="number"
                          min={1}
                          max={1000}
                          step={1}
                          required
                          value={node.weight}
                          onChange={(event) =>
                            patchNode(node.clientKey, {
                              weight: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label className={LABEL_CLASS}>
                        <span className="block">接口协议</span>
                        <select
                          className={FIELD_CLASS}
                          value={node.pi_api}
                          onChange={(event) => {
                            const piApi = event.target
                              .value as NodeInput['pi_api'];
                            patchNode(node.clientKey, {
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
                          <option value="openai-completions">
                            OpenAI 对话接口
                          </option>
                          <option value="openai-responses">
                            OpenAI Responses 接口
                          </option>
                          <option value="anthropic-messages">
                            Anthropic 消息接口
                          </option>
                          <option value="google-generative-ai">
                            Google Gemini
                          </option>
                        </select>
                      </label>
                      <label className={LABEL_CLASS}>
                        <span className="block">模型名称</span>
                        <input
                          className={FIELD_CLASS}
                          required
                          maxLength={120}
                          value={node.model_name}
                          placeholder="供应商提供的模型 ID"
                          onChange={(event) =>
                            patchNode(node.clientKey, {
                              model_name: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className={`${LABEL_CLASS} sm:col-span-2`}>
                        <span className="block">接口地址</span>
                        <input
                          className={FIELD_CLASS}
                          type="url"
                          maxLength={500}
                          value={node.base_url ?? ''}
                          placeholder="留空使用默认接口地址"
                          onChange={(event) =>
                            patchNode(node.clientKey, {
                              base_url: event.target.value || null,
                            })
                          }
                        />
                      </label>
                      <label className={`${LABEL_CLASS} sm:col-span-2`}>
                        <span className="block">API 密钥</span>
                        <input
                          className={FIELD_CLASS}
                          type="password"
                          autoComplete="new-password"
                          maxLength={2000}
                          required={node.enabled && !node.hasSecret}
                          value={node.api_key ?? ''}
                          placeholder={
                            node.hasSecret
                              ? '留空保留已保存的密钥'
                              : '请输入 API 密钥'
                          }
                          onChange={(event) =>
                            patchNode(node.clientKey, {
                              api_key: event.target.value,
                            })
                          }
                        />
                        <span className="block">
                          更换接口协议、地址或认证方式时，需要重新填写密钥。
                        </span>
                      </label>
                      <label className={LABEL_CLASS}>
                        <span className="block">上下文窗口（Token）</span>
                        <input
                          className={FIELD_CLASS}
                          type="number"
                          min={0}
                          max={2000000}
                          step={1}
                          value={node.context_window_tokens ?? 0}
                          onChange={(event) =>
                            patchNode(node.clientKey, {
                              context_window_tokens:
                                Number(event.target.value) || null,
                            })
                          }
                        />
                        <span className="block">
                          填 0 自动识别，自定义模型建议手动填写。
                        </span>
                      </label>
                      {node.pi_api === 'anthropic-messages' && (
                        <label className={LABEL_CLASS}>
                          <span className="block">认证方式</span>
                          <select
                            className={FIELD_CLASS}
                            value={node.auth_mode ?? 'anthropic_api_key'}
                            onChange={(event) =>
                              patchNode(node.clientKey, {
                                auth_mode: event.target
                                  .value as NodeInput['auth_mode'],
                              })
                            }
                          >
                            <option value="anthropic_api_key">API 密钥</option>
                            <option value="claude_code_oauth_token">
                              Claude Code OAuth 令牌
                            </option>
                          </select>
                        </label>
                      )}
                      {node.cooldownUntil && (
                        <p className="text-[12px] leading-6 text-warning sm:col-span-2">
                          连续故障 {node.failureCount} 次，
                          {new Date(node.cooldownUntil).toLocaleString(
                            'zh-CN',
                          )}{' '}
                          后允许恢复探测。
                        </p>
                      )}
                    </div>
                  </fieldset>
                  {node.isPrimary && (
                    <div className="flex items-center justify-between gap-3 pt-2">
                      <div>
                        <h3 className="text-sm font-semibold">
                          子节点{' '}
                          <span className="font-normal text-muted">
                            （{draft.nodes.length - 1}）
                          </span>
                        </h3>
                        <p className="mt-1 text-[12px] text-muted">
                          自由添加、编辑和删除。节点故障后暂时冷却，恢复后重新加入。
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={saving || draft.nodes.length >= 20}
                        onClick={() =>
                          patchDraft({ nodes: [...draft.nodes, newNode()] })
                        }
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-primary/35 px-3 text-[12px] text-primary disabled:opacity-50"
                      >
                        <Plus size={14} /> 添加子节点
                      </button>
                    </div>
                  )}
                </Fragment>
              );
            })}
            {draft.nodes.length === 1 && (
              <p className="rounded-lg border border-dashed border-hairline px-5 py-6 text-center text-[12px] text-muted">
                暂未添加子节点，主节点可独立供应。
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-3 border-t border-hairline pt-4">
            {saved && (
              <span role="status" className="text-[12px] text-success">
                模型池已保存
              </span>
            )}
            <button
              type="submit"
              disabled={saving || !draft.nodes.length}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:bg-primary-active disabled:opacity-50"
            >
              <Save size={14} /> {saving ? '保存中…' : '保存模型池'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
