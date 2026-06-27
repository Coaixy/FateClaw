'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Copy, KeyRound, Plus } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { ApiError } from '@/lib/http/client';
import { useToast } from '@/lib/use-toast';
import { useConfirm } from '@/lib/use-confirm';
import { apiKeysApi, type ApiKey } from '@/features/api-keys/api-keys-api';
import { MAX_API_KEYS_PER_USER } from '@fateclaw/contracts/api-keys';

/** 把 ISO 时间格式化为 YYYY-MM-DD；非法日期返回占位符，避免脏数据导致整页崩溃。 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** 从 ApiError 取可读文案，兜底默认提示。 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * API Key 管理设置页（站内，需登录）。
 *
 * 列出 / 生成 / 吊销当前用户的对外开放 API Key。生成的明文密钥只在创建响应里返回一次，
 * 用 BottomSheet 展示并支持一键复制；关闭后无法再查看。
 */
export function ApiKeysWorkspace() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 生成流程：输入名称的 sheet。
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // 生成结果：明文 key 一次性展示的 sheet。
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const activeCount = keys.filter((k) => k.status === 'active').length;
  const reachedLimit = activeCount >= MAX_API_KEYS_PER_USER;

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiKeysApi.list();
      setKeys(res.api_keys);
    } catch (error) {
      setLoadError(errorMessage(error, '加载失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast('warning', '请填写 Key 名称');
      return;
    }
    setCreating(true);
    try {
      const created = await apiKeysApi.create({ name });
      setCreateOpen(false);
      setNewName('');
      setGeneratedKey(created.key); // 明文仅此一次。
      setCopied(false);
      await refresh();
    } catch (error) {
      // 会员过期/欠费等由后端返回 403/402，文案原样透出。
      toast('error', errorMessage(error, '生成失败，请稍后重试'));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!generatedKey) return;
    try {
      await navigator.clipboard.writeText(generatedKey);
      setCopied(true);
      toast('success', '已复制到剪贴板');
    } catch {
      toast('error', '复制失败，请手动选择复制');
    }
  }

  async function handleRevoke(key: ApiKey) {
    const ok = await confirm({
      title: '吊销该 API Key？',
      message: `「${key.name}」吊销后立即失效且无法恢复，使用它的程序将无法再调用 API。`,
      variant: 'danger',
      confirmLabel: '吊销',
    });
    if (!ok) return;
    try {
      await apiKeysApi.revoke(key.id);
      toast('success', 'API Key 已吊销');
      await refresh();
    } catch (error) {
      toast('error', errorMessage(error, '吊销失败，请稍后重试'));
    }
  }

  return (
    <AppShell wide>
      <div className="mx-auto max-w-4xl">
        {/* 标题区 */}
        <div className="mb-6 border-b border-hairline/70 pb-5">
          <Link
            href="/profile"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-1 text-[12px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={13} />
            返回个人中心
          </Link>
          <h2 className="font-display mt-2 text-xl font-semibold tracking-tight text-ink">
            API Key
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
            用于程序化调用 FateClaw 开放 API（排盘 + Agent）。仅会员可生成；明文密钥只在创建时展示一次，请妥善保存。
            <Link href="/docs/api" className="ml-1 text-primary hover:underline">
              查看 API 文档 →
            </Link>
          </p>
        </div>

        {/* 操作区 */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            有效 {activeCount} / {MAX_API_KEYS_PER_USER}
          </span>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            disabled={reachedLimit}
            onClick={() => {
              setNewName('');
              setCreateOpen(true);
            }}
          >
            生成 API Key
          </Button>
        </div>
        {reachedLimit && (
          <p className="mb-3 text-[12px] text-muted">
            已达数量上限，请先吊销不再使用的 Key。
          </p>
        )}

        {/* 列表 */}
        {loading ? (
          <div className="py-12 text-center text-[13px] text-muted">加载中…</div>
        ) : loadError ? (
          <div className="py-12 text-center text-[13px] text-error">
            {loadError}
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-hairline py-12 text-center">
            <KeyRound size={28} className="mx-auto mb-3 text-muted" />
            <p className="text-[13px] text-muted">
              还没有 API Key，点击右上角生成第一个。
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {keys.map((key) => (
              <li
                key={key.id}
                className="flex items-center justify-between gap-4 rounded-2xl border border-hairline bg-surface-card p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium text-ink">
                      {key.name}
                    </span>
                    {key.status === 'revoked' && (
                      <span className="rounded-md bg-surface-cream-strong px-1.5 py-0.5 text-[11px] text-muted">
                        已吊销
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[12px] text-muted">
                    {key.key_prefix}····{key.last_four}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    创建于 {formatDate(key.created_at)}
                    {key.last_used_at
                      ? ` · 最近使用 ${formatDate(key.last_used_at)}`
                      : ' · 从未使用'}
                    {key.expires_at ? ` · ${formatDate(key.expires_at)} 过期` : ''}
                  </div>
                </div>
                {key.status === 'active' && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void handleRevoke(key)}
                  >
                    吊销
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 生成：输入名称 */}
      <BottomSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="生成 API Key"
        size="sm"
      >
        <div className="space-y-4 p-4 sm:p-6">
          <label className="block">
            <span className="text-[13px] text-ink">名称</span>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={50}
              placeholder="例如：我的自动化脚本"
              className="mt-1.5 w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-[14px] text-ink outline-none transition-colors focus:border-primary/40"
            />
            <span className="mt-1 block text-[11px] text-muted">
              便于区分用途，最多 50 字。
            </span>
          </label>
          <Button
            variant="primary"
            size="md"
            loading={creating}
            onClick={() => void handleCreate()}
            className="w-full"
          >
            生成
          </Button>
        </div>
      </BottomSheet>

      {/* 生成结果：明文一次性展示（禁止点遮罩误关，避免还没复制就关掉） */}
      <BottomSheet
        open={generatedKey !== null}
        onClose={() => setGeneratedKey(null)}
        title="API Key 已生成"
        size="md"
        closeOnOverlay={false}
      >
        <div className="space-y-3 p-4 sm:p-6">
          <p className="text-[13px] text-ink">
            请立即复制并妥善保存。
            <span className="text-error">关闭后将无法再次查看明文。</span>
          </p>
          <div className="flex items-center gap-2 rounded-lg bg-surface-cream-strong p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">
              {generatedKey}
            </code>
            <Button
              variant="secondary"
              size="sm"
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => void handleCopy()}
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="md"
            onClick={() => setGeneratedKey(null)}
            className="w-full"
          >
            我已保存，关闭
          </Button>
        </div>
      </BottomSheet>
    </AppShell>
  );
}
