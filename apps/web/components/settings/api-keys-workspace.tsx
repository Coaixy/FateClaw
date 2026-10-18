'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';

import { DeveloperShell } from '@/components/developer/developer-shell';
import { ApiQuickstart } from '@/components/developer/api-quickstart';
import { Button } from '@/components/ui/button';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { ApiError } from '@/lib/http/client';
import { useToast } from '@/lib/use-toast';
import { useConfirm } from '@/lib/use-confirm';
import { useAuth } from '@/features/auth/hooks/use-auth';
import {
  apiKeysApi,
  type ApiKey,
  type ApiKeyCreated,
} from '@/features/api-keys/api-keys-api';
import { getApiKeyStatus } from '@/features/api-keys/key-status';
import { MAX_API_KEYS_PER_USER } from '@fateclaw/contracts/api-keys';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('sv-SE');
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

const STATUS_LABEL = {
  active: '可用',
  expired: '已过期',
  revoked: '已吊销',
} as const;
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '可用' },
  { id: 'inactive', label: '已失效' },
] as const;
type KeyFilter = (typeof FILTERS)[number]['id'];

export function ApiKeysWorkspace() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { user } = useAuth();
  const [list, setList] = useState<{
    keys: ApiKey[];
    loading: boolean;
    error: string | null;
  }>({ keys: [], loading: true, error: null });
  const [filter, setFilter] = useState<KeyFilter>('all');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [validity, setValidity] = useState('never');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [membershipRequired, setMembershipRequired] = useState(false);
  const [generated, setGenerated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const createPending = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const loadVersion = useRef(0);

  const { keys, loading, error: loadError } = list;
  const usableCount = keys.filter(
    (key) => getApiKeyStatus(key) === 'active',
  ).length;
  // The server quota counts all unrevoked keys, including expired ones.
  const allocatedCount = keys.filter((key) => key.status === 'active').length;
  const reachedLimit = allocatedCount >= MAX_API_KEYS_PER_USER;
  const createDisabled =
    reachedLimit || loading || Boolean(loadError) || creating;
  const visibleKeys = keys.filter((key) => {
    const status = getApiKeyStatus(key);
    return (
      (filter === 'all' ||
        (filter === 'active' ? status === 'active' : status !== 'active')) &&
      `${key.name} ${key.key_prefix} ${key.last_four}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    );
  });

  const refresh = useCallback(async () => {
    if (!user) return;
    const version = ++loadVersion.current;
    setList((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await apiKeysApi.list();
      if (version === loadVersion.current)
        setList({ keys: response.api_keys, loading: false, error: null });
    } catch (error) {
      if (version === loadVersion.current)
        setList((previous) => ({
          ...previous,
          loading: false,
          error: errorMessage(error, '密钥加载失败，请重试'),
        }));
    }
  }, [user]);

  useEffect(() => {
    void refresh();
    return () => {
      loadVersion.current += 1;
    };
  }, [refresh]);

  function openCreate() {
    if (createDisabled) return;
    setName('');
    setValidity('never');
    setCreateError('');
    setMembershipRequired(false);
    setCreateOpen(true);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createPending.current || !name.trim()) return;
    createPending.current = true;
    setCreating(true);
    setCreateError('');
    setMembershipRequired(false);
    try {
      const created = await apiKeysApi.create({
        name: name.trim(),
        expires_at:
          validity === 'never'
            ? null
            : new Date(
                Date.now() + Number(validity) * 86_400_000,
              ).toISOString(),
      });
      const { key: plaintext, ...metadata } = created;
      setList((previous) => ({
        ...previous,
        keys: [metadata, ...previous.keys],
      }));
      setCreateOpen(false);
      setGenerated({ ...metadata, key: plaintext });
      setCopied(false);
      setFilter('all');
      setSearch('');
    } catch (error) {
      setCreateError(errorMessage(error, '生成失败，请稍后重试'));
      setMembershipRequired(error instanceof ApiError && error.status === 403);
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }

  async function copyGenerated() {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.key);
      setCopied(true);
    } catch {
      toast('error', '复制失败，请手动选择并复制密钥');
    }
  }

  async function closeGenerated() {
    const saved = await confirm({
      title: '确认已保存 API Key？',
      message: '关闭后无法再次查看完整密钥，请确认已经复制并妥善保存。',
      confirmLabel: '已保存，关闭',
    });
    if (saved) setGenerated(null);
  }

  async function handleRevoke(key: ApiKey) {
    if (revoking) return;
    const accepted = await confirm({
      title: '吊销该 API Key？',
      message: `「${key.name}」吊销后立即失效且无法恢复，使用它的程序将无法再调用 API。`,
      variant: 'danger',
      confirmLabel: '确认吊销',
    });
    if (!accepted) return;
    setRevoking(key.id);
    try {
      await apiKeysApi.revoke(key.id);
      setList((previous) => ({
        ...previous,
        keys: previous.keys.map((item) =>
          item.id === key.id ? { ...item, status: 'revoked' } : item,
        ),
      }));
      toast('success', 'API Key 已吊销');
    } catch (error) {
      toast('error', errorMessage(error, '吊销失败，请稍后重试'));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <DeveloperShell
      active="keys"
      title="API Key"
      description="管理应用的访问密钥，从排盘计算到 AI 解读，让能力融入你的工作流。"
      actions={
        <Button
          icon={<Plus size={15} />}
          disabled={createDisabled}
          onClick={openCreate}
        >
          生成 API Key
        </Button>
      }
    >
      <ApiQuickstart onCreate={openCreate} disabled={createDisabled} />

      <section aria-labelledby="key-management-title">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="key-management-title"
              className="flex items-center gap-2.5 text-[17px] font-medium text-ink"
            >
              密钥管理
              <span className="rounded-md bg-surface-card px-2 py-0.5 font-mono text-[11px] font-normal text-muted">
                {loading ? '…' : `${usableCount} 个可用`}
              </span>
            </h2>
            <p className="mt-1.5 text-xs leading-6 text-muted">
              为不同应用创建独立密钥，便于识别用途与停用。
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || creating || Boolean(revoking)}
            onClick={() => void refresh()}
            icon={
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            }
          >
            刷新
          </Button>
        </div>

        <div className="overflow-hidden rounded-xl border border-hairline bg-surface-raised">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline p-3 sm:px-5">
            <div className="flex gap-1" aria-label="密钥状态筛选">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                  className={`min-h-9 rounded-md px-3 text-xs transition-colors ${filter === item.id ? 'bg-surface-soft font-medium text-ink' : 'text-muted hover:text-ink'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-hairline bg-canvas px-3 sm:w-56">
              <Search
                size={14}
                className="shrink-0 text-muted"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="搜索密钥名称或尾号"
                placeholder="搜索名称或密钥尾号"
                className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-muted-soft"
              />
            </label>
          </div>

          {loadError && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 border-b border-error/15 bg-error/5 px-5 py-3 text-xs text-error"
            >
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={14} />
                {loadError}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="min-h-8 font-medium underline"
              >
                重新加载
              </button>
            </div>
          )}
          {loading && keys.length === 0 ? (
            <div
              role="status"
              className="px-5 py-16 text-center text-xs text-muted"
            >
              正在加载密钥…
            </div>
          ) : keys.length === 0 && !loadError ? (
            <div className="px-5 py-14 text-center">
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-hairline bg-surface-soft text-primary">
                <KeyRound size={21} aria-hidden="true" />
              </span>
              <h3 className="text-sm font-medium text-ink">
                创建你的第一个 API Key
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-6 text-muted">
                生成密钥后，就可以从你的应用或脚本调用
                FateClaw。仅会员可生成密钥。
              </p>
              <Button
                size="sm"
                className="mt-5"
                onClick={openCreate}
                icon={<Plus size={13} />}
              >
                创建第一个密钥
              </Button>
            </div>
          ) : visibleKeys.length === 0 && !loadError ? (
            <div className="px-5 py-14 text-center text-xs text-muted">
              没有符合条件的密钥。
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setFilter('all');
                }}
                className="ml-2 text-primary hover:underline"
              >
                清除筛选
              </button>
            </div>
          ) : keys.length > 0 ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <caption className="sr-only">
                  API Key 列表，包含状态、创建日期、最近使用时间和有效期
                </caption>
                <thead className="border-b border-hairline bg-surface-soft/45 text-[11px] text-muted">
                  <tr>
                    {[
                      '名称 / 密钥',
                      '状态',
                      '创建日期',
                      '最近使用',
                      '有效期',
                      '操作',
                    ].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className="px-5 py-3 font-normal last:text-right"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline/70">
                  {visibleKeys.map((key) => {
                    const status = getApiKeyStatus(key);
                    return (
                      <tr key={key.id} className="hover:bg-surface-soft/35">
                        <th
                          scope="row"
                          className="max-w-64 px-5 py-4 font-normal"
                        >
                          <div
                            className="truncate font-medium text-ink"
                            title={key.name}
                          >
                            {key.name}
                          </div>
                          <code className="mt-1.5 block whitespace-nowrap font-mono text-[11px] text-muted">
                            {key.key_prefix}••••{key.last_four}
                          </code>
                        </th>
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[10px] ${status === 'active' ? 'bg-success/10 text-chart-wood' : status === 'expired' ? 'bg-warning/10 text-warning' : 'bg-surface-soft text-muted'}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${status === 'active' ? 'bg-success' : status === 'expired' ? 'bg-warning' : 'bg-muted-soft'}`}
                            />
                            {STATUS_LABEL[status]}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-[11px] text-muted">
                          {formatDate(key.created_at)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-[11px] text-muted">
                          {key.last_used_at ? (
                            formatDate(key.last_used_at)
                          ) : (
                            <span className="font-sans">尚未使用</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-[11px] text-muted">
                          {key.expires_at ? (
                            <span className="font-mono">
                              {formatDate(key.expires_at)}
                            </span>
                          ) : (
                            '长期有效'
                          )}
                        </td>
                        <td className="px-5 py-4 text-right">
                          {key.status === 'active' ? (
                            <button
                              type="button"
                              disabled={Boolean(revoking)}
                              aria-label={`吊销 ${key.name}`}
                              onClick={() => void handleRevoke(key)}
                              className="min-h-8 rounded-md px-2 text-[11px] text-muted hover:bg-error/5 hover:text-error disabled:opacity-50"
                            >
                              {revoking === key.id ? '吊销中…' : '吊销'}
                            </button>
                          ) : (
                            <span className="text-muted-soft">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-canvas/50 px-5 py-3 text-[11px] text-muted">
            <span>
              {loading
                ? '正在同步…'
                : loadError
                  ? '密钥数量暂不可用'
                  : `未吊销密钥 ${allocatedCount} / ${MAX_API_KEYS_PER_USER}`}
            </span>
            <span>完整密钥仅在生成时显示一次</span>
          </div>
        </div>
        {reachedLimit && (
          <p className="mt-3 text-xs leading-6 text-warning">
            已达 {MAX_API_KEYS_PER_USER}{' '}
            个未吊销密钥的上限。请先吊销不用或已过期的密钥，再创建新密钥。
          </p>
        )}
      </section>

      <div className="mt-6 flex items-start gap-3 rounded-xl border border-hairline bg-surface-soft/40 p-4 sm:p-5">
        <ShieldCheck
          size={18}
          className="mt-0.5 shrink-0 text-primary"
          aria-hidden="true"
        />
        <div>
          <h3 className="text-xs font-medium text-ink">让密钥留在服务端</h3>
          <p className="mt-1 text-xs leading-6 text-muted">
            请通过服务端环境变量使用 API
            Key，避免放入浏览器代码、公开仓库或分享链接。怀疑泄露时，先吊销，再生成新密钥。
          </p>
        </div>
      </div>

      <BottomSheet
        open={createOpen}
        onClose={() => {
          if (!creating) setCreateOpen(false);
        }}
        title="生成 API Key"
        size="md"
        aria-label="生成 API Key"
        initialFocusRef={nameInputRef}
      >
        <form
          onSubmit={(event) => void handleCreate(event)}
          className="developer-workspace space-y-6 p-5 sm:p-6"
        >
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 font-mono text-primary">
              1
            </span>
            <span className="text-ink">配置密钥</span>
            <span className="mx-2 h-px flex-1 bg-hairline" />
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-hairline font-mono">
              2
            </span>
            复制并保存
          </div>
          <label className="block">
            <span className="text-[13px] font-medium text-ink">密钥名称</span>
            <input
              autoFocus
              ref={nameInputRef}
              aria-label="密钥名称"
              autoComplete="off"
              value={name}
              disabled={creating}
              onChange={(event) => setName(event.target.value)}
              maxLength={50}
              required
              placeholder="例如：生产环境 / 本地开发"
              className="mt-2 h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-[13px] text-ink outline-none focus:border-primary"
            />
            <span className="mt-2 block text-[11px] leading-5 text-muted">
              使用应用或环境命名，便于后续识别。最多 50 个字符。
            </span>
          </label>
          <label className="block">
            <span className="text-[13px] font-medium text-ink">有效期</span>
            <select
              value={validity}
              disabled={creating}
              onChange={(event) => setValidity(event.target.value)}
              className="mt-2 h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-[13px] text-ink"
            >
              <option value="never">长期有效</option>
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="365">365 天</option>
            </select>
            <span className="mt-2 block text-[11px] text-muted">
              到期后密钥自动失效，无法继续调用。
            </span>
          </label>
          <div className="rounded-lg bg-surface-soft p-3.5 text-xs leading-6 text-muted">
            仅会员可生成密钥。密钥可调用账户已开放的 API 能力；AI
            解读与站内共用积分余额。
          </div>
          {createError && (
            <div
              role="alert"
              className="rounded-lg border border-error/20 bg-error/5 p-3 text-xs leading-6 text-error"
            >
              {createError}
              {membershipRequired && (
                <Link
                  href="/membership"
                  className="mt-1 flex items-center gap-1 font-medium underline"
                >
                  开通或续费会员
                  <ArrowUpRight size={12} />
                </Link>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2 border-t border-hairline pt-5">
            <Button
              type="button"
              variant="ghost"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              loading={creating}
              disabled={!name.trim()}
              icon={<KeyRound size={14} />}
            >
              生成密钥
            </Button>
          </div>
        </form>
      </BottomSheet>

      <BottomSheet
        open={generated !== null}
        onClose={() => void closeGenerated()}
        title="API Key 已生成"
        size="md"
        closeOnOverlay={false}
        aria-label="API Key 已生成"
        initialFocusRef={copyButtonRef}
      >
        <div className="developer-workspace space-y-5 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-chart-wood">
              <CheckCircle2 size={21} />
            </span>
            <div>
              <p className="text-sm font-medium text-ink">{generated?.name}</p>
              <p className="mt-1 text-[11px] text-muted">
                {generated?.expires_at
                  ? `有效至 ${formatDate(generated.expires_at)}`
                  : '长期有效，可随时吊销'}
              </p>
            </div>
          </div>
          <p className="rounded-lg border border-warning/20 bg-warning/5 px-3.5 py-3 text-xs leading-6 text-body">
            <strong className="font-medium text-ink">请现在复制并保存。</strong>
            完整密钥仅显示这一次，关闭后无法找回。
          </p>
          <label className="block">
            <span className="text-[11px] text-muted">你的 API Key</span>
            <textarea
              readOnly
              autoComplete="off"
              spellCheck={false}
              aria-label="新生成的 API Key"
              value={generated?.key ?? ''}
              rows={3}
              className="mt-2 w-full resize-none rounded-lg border border-hairline bg-canvas p-3 font-mono text-xs leading-6 text-ink"
            />
          </label>
          <Button
            ref={copyButtonRef}
            className="w-full"
            variant="secondary"
            icon={copied ? <Check size={15} /> : <Copy size={15} />}
            onClick={() => void copyGenerated()}
          >
            {copied ? '密钥已复制' : '复制 API Key'}
          </Button>
          <div className="border-t border-hairline pt-4">
            <Button className="w-full" onClick={() => setGenerated(null)}>
              我已保存，完成
            </Button>
            <p className="mt-2 text-center text-[11px] text-muted">
              接下来，将密钥设置为服务端的 FATECLAW_API_KEY 环境变量。
            </p>
          </div>
        </div>
      </BottomSheet>
    </DeveloperShell>
  );
}
