'use client';

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Ban,
  Check,
  Copy,
  Plus,
  RefreshCw,
  Save,
  Search,
  Ticket,
  Trash2,
} from 'lucide-react';
import type {
  CompletedRechargeRefundDto,
  CompletedRechargeRefundRequestDto,
  CreatedRegistrationInviteDto,
  RegistrationInviteDto,
  RegistrationInvitePolicyDto,
  RegistrationInviteStatus,
  RegistrationInviteSummaryDto,
  RegistrationInviteTierDto,
} from '@fateclaw/contracts/auth';
import { formatAdminErrorMessage } from '@/lib/admin-api';
import { adminRegistrationInvites } from '@/lib/admin-registration-invites-api';
import { hasAdminScope } from '@/lib/admin-navigation';
import { useAdminSession } from '@/lib/admin-session';
import { useConfirm } from '@/lib/use-confirm';
import {
  AdminField,
  AdminInput,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminStatusBadge,
  AdminTextarea,
} from '@/components/ui/admin-controls';
import {
  AdminAlert,
  AdminEmptyState,
  AdminLoadingState,
  AdminPageHeader,
} from '@/components/ui/admin-states';

const statusLabels: Record<RegistrationInviteStatus, string> = {
  active: '待使用',
  used: '已使用',
  revoked: '已撤销',
  expired: '已过期',
  suspended: '已暂停',
};

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function Section({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-soft p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">{title}</h2>
          {description ? (
            <p className="mt-1 text-[12px] leading-5 text-muted">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function InviteList({
  items,
  busy,
  onRevoke,
}: {
  items: RegistrationInviteDto[];
  busy: boolean;
  onRevoke: (item: RegistrationInviteDto) => void;
}) {
  if (!items.length) return <AdminEmptyState title="暂无邀请码" />;
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full min-w-[600px] text-left text-[12px]">
        <thead className="bg-surface-card text-muted">
          <tr>
            <th className="px-3 py-2.5 font-medium">邀请码尾号</th>
            <th className="px-3 py-2.5 font-medium">来源</th>
            <th className="px-3 py-2.5 font-medium">状态</th>
            <th className="px-3 py-2.5 font-medium">有效期 / 使用时间</th>
            <th className="px-3 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline bg-canvas">
          {items.map((item) => (
            <tr key={item.id}>
              <td className="px-3 py-3 font-mono">…{item.code_suffix}</td>
              <td className="px-3 py-3">
                {item.source === 'admin' ? '运营发放' : '用户邀请'}
              </td>
              <td className="px-3 py-3">
                <AdminStatusBadge
                  tone={
                    item.status === 'active'
                      ? 'success'
                      : item.status === 'suspended'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {statusLabels[item.status]}
                </AdminStatusBadge>
              </td>
              <td className="px-3 py-3 text-muted">
                <div>到期 {formatTime(item.expires_at)}</div>
                {item.used_at ? (
                  <div className="mt-1">使用 {formatTime(item.used_at)}</div>
                ) : null}
              </td>
              <td className="px-3 py-3 text-right">
                {item.status === 'active' || item.status === 'suspended' ? (
                  <button
                    type="button"
                    disabled={busy}
                    className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-error disabled:opacity-40"
                    onClick={() => onRevoke(item)}
                    aria-label={`撤销尾号 ${item.code_suffix} 的邀请码`}
                  >
                    <Ban size={12} />
                    撤销
                  </button>
                ) : (
                  <span className="text-muted-soft">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminRegistrationInvitesPage() {
  const session = useAdminSession();
  const canManage = hasAdminScope(session.scopes, 'admin:*');
  const { confirm } = useConfirm();
  const [policy, setPolicy] = useState<RegistrationInvitePolicyDto | null>(
    null,
  );
  const [policyDraft, setPolicyDraft] = useState({
    tiers: [
      { threshold: '30', slots: '3' },
      { threshold: '100', slots: '5' },
      { threshold: '300', slots: '10' },
    ],
    days: '7',
  });
  const [query, setQuery] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [summary, setSummary] = useState<RegistrationInviteSummaryDto | null>(
    null,
  );
  const [totalSlots, setTotalSlots] = useState('');
  const [suspended, setSuspended] = useState(false);
  const [viewAll, setViewAll] = useState(true);
  const [invitations, setInvitations] = useState<RegistrationInviteDto[]>([]);
  const [refunds, setRefunds] = useState<CompletedRechargeRefundDto[]>([]);
  const [refund, setRefund] = useState({
    trade_id: '',
    amount: '',
    reference: '',
    reason: '',
  });
  const [refundConfirmed, setRefundConfirmed] = useState(false);
  const [created, setCreated] = useState<CreatedRegistrationInviteDto | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [createUncertain, setCreateUncertain] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState('');
  const actionPending = useRef(false);
  const createRequestKey = useRef<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    let active = true;
    setLoading(true);
    setLoadError('');
    const filter = !viewAll && selectedUserId ? selectedUserId : undefined;
    void Promise.allSettled([
      adminRegistrationInvites.policy(),
      adminRegistrationInvites.list(filter),
      adminRegistrationInvites.refunds(filter),
      selectedUserId
        ? adminRegistrationInvites.user(selectedUserId)
        : Promise.resolve(null),
    ]).then(([policyResult, inviteResult, refundResult, userResult]) => {
      if (!active) return;
      const errors: string[] = [];
      if (policyResult.status === 'fulfilled') {
        setPolicy(policyResult.value);
      } else
        errors.push(
          formatAdminErrorMessage(policyResult.reason, '邀请规则加载失败'),
        );
      if (inviteResult.status === 'fulfilled')
        setInvitations(inviteResult.value.items);
      else
        errors.push(
          formatAdminErrorMessage(inviteResult.reason, '邀请码加载失败'),
        );
      if (refundResult.status === 'fulfilled')
        setRefunds(refundResult.value.items);
      else
        errors.push(
          formatAdminErrorMessage(refundResult.reason, '退款记录加载失败'),
        );
      if (userResult.status === 'fulfilled') {
        setSummary(userResult.value);
      } else {
        setSummary(null);
        errors.push(
          formatAdminErrorMessage(userResult.reason, '用户邀请资格加载失败'),
        );
      }
      setLoadError([...new Set(errors)].join('；'));
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [canManage, selectedUserId, viewAll, reload]);

  const policyTiers = policy ? JSON.stringify(policy.tiers) : undefined;
  const policyDays = policy?.expires_in_days;
  const policyRevision = policy?.revision;
  useEffect(() => {
    if (policyTiers === undefined || policyDays === undefined) return;
    setPolicyDraft({
      tiers: (JSON.parse(policyTiers) as RegistrationInviteTierDto[]).map(
        (tier) => ({
          threshold: String(tier.threshold_yuan),
          slots: String(tier.total_slots),
        }),
      ),
      days: String(policyDays),
    });
  }, [policyTiers, policyDays, policyRevision]);

  const accountId = summary?.user_id;
  const accountSlots = summary?.total_slots;
  const accountSuspended = summary?.suspended;
  const accountRevision = summary?.revision;
  useEffect(() => {
    setTotalSlots(accountSlots === undefined ? '' : String(accountSlots));
    setSuspended(accountSuspended ?? false);
  }, [accountId, accountSlots, accountSuspended, accountRevision]);

  async function runAction(key: string, action: () => Promise<void>) {
    if (!canManage || actionPending.current) return;
    actionPending.current = true;
    setBusy(key);
    setActionError('');
    setSuccess('');
    try {
      await action();
      setReload((current) => current + 1);
    } catch (error) {
      setActionError(formatAdminErrorMessage(error, '操作失败，请重试'));
    } finally {
      actionPending.current = false;
      setBusy('');
    }
  }

  function lookupUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionPending.current || loading) return;
    setSummary(null);
    setSelectedUserId(query.trim());
    setViewAll(false);
    setReload((current) => current + 1);
  }

  function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!policy) return;
    const tiers = policyDraft.tiers.map((tier) => ({
      threshold_yuan: Number(tier.threshold),
      total_slots: Number(tier.slots),
    }));
    if (
      tiers.some(
        (tier, index) =>
          index > 0 &&
          (tier.threshold_yuan <= tiers[index - 1].threshold_yuan ||
            tier.total_slots <= tiers[index - 1].total_slots),
      )
    ) {
      setActionError('各阶梯的充值门槛和累计总名额都必须依次递增。');
      setSuccess('');
      return;
    }
    void runAction('policy', async () => {
      const next = await adminRegistrationInvites.updatePolicy({
        tiers,
        expires_in_days: Number(policyDraft.days),
        expected_revision: policy.revision,
      });
      setPolicy(next);
      setSuccess(
        '邀请规则已保存。用户按最高达标阶梯重算自动名额，人工调整和已注册账号保留。',
      );
    });
  }

  function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!summary) return;
    void runAction('user', async () => {
      const next = await adminRegistrationInvites.updateUser(summary.user_id, {
        total_slots: Number(totalSlots),
        suspended,
        expected_revision: summary.revision,
      });
      setSummary(next);
      setSuccess('用户邀请设置已保存。');
    });
  }

  function createInvite() {
    void runAction('create', async () => {
      // Retain the request key after an uncertain response so retries cannot issue another code.
      createRequestKey.current ??= crypto.randomUUID();
      setCreateUncertain(true);
      const next = await adminRegistrationInvites.create({
        request_key: createRequestKey.current,
      });
      setCreated(next);
      setCopied(false);
      createRequestKey.current = null;
      setCreateUncertain(false);
      setSuccess(
        next.code
          ? '运营邀请码已生成，请立即复制保存。'
          : '已找到上次生成的邀请码。完整邀请码无法再次获取，请撤销后重新生成。',
      );
    });
  }

  async function revokeInvite(item: RegistrationInviteDto) {
    if (actionPending.current) return;
    const accepted = await confirm({
      title: '撤销邀请码',
      message: `撤销尾号 ${item.code_suffix} 的邀请码后，它将无法用于领取体验会员。用户邀请码占用的名额将被释放，新用户仍可正常注册。`,
      confirmLabel: '撤销邀请码',
      variant: 'danger',
    });
    if (!accepted) return;
    await runAction(`revoke:${item.id}`, async () => {
      await adminRegistrationInvites.revoke(item.id);
      setCreated((current) =>
        current?.invite.id === item.id ? null : current,
      );
      setSuccess('邀请码已撤销。');
    });
  }

  async function copyCode() {
    if (!created?.code) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
    } catch {
      setActionError('复制失败，请手动选中邀请码复制。');
    }
  }

  function recordRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!refundConfirmed) return;
    const body: CompletedRechargeRefundRequestDto = {
      trade_id: refund.trade_id.trim(),
      amount_yuan: Number(refund.amount),
      reference: refund.reference.trim(),
      reason: refund.reason.trim(),
    };
    void runAction('refund', async () => {
      await adminRegistrationInvites.recordCompletedRefund(body);
      setRefund({ trade_id: '', amount: '', reference: '', reason: '' });
      setRefundConfirmed(false);
      setSuccess(
        '已记录支付渠道完成的退款，并更新订单所属用户的邀请资格。钱包余额未调整。',
      );
    });
  }

  if (!canManage)
    return <AdminAlert tone="error">仅所有者可管理会员邀请。</AdminAlert>;

  const disabled = !!busy || loading;
  const occupiedSlots = summary
    ? summary.used_slots + summary.reserved_slots
    : 0;
  const filtered = !!selectedUserId && !viewAll;

  return (
    <div className="space-y-5">
      <AdminPageHeader
        icon={Ticket}
        title="会员邀请"
        description="开放手机号注册，新用户使用有效邀请码可获赠 72 小时体验会员。管理邀请资格、运营邀请码与已完成退款记录。"
        action={
          <AdminSecondaryButton
            icon={RefreshCw}
            disabled={disabled}
            onClick={() => setReload((current) => current + 1)}
          >
            刷新
          </AdminSecondaryButton>
        }
      />

      {success ? (
        <div role="status">
          <AdminAlert tone="success">{success}</AdminAlert>
        </div>
      ) : null}
      {actionError ? (
        <div role="alert">
          <AdminAlert tone="error">{actionError}</AdminAlert>
        </div>
      ) : null}
      {loadError ? (
        <div role="alert">
          <AdminAlert tone="error">{loadError}。请刷新后再操作。</AdminAlert>
        </div>
      ) : null}
      {loading && !policy ? <AdminLoadingState label="加载邀请配置" /> : null}

      <Section
        title="邀请规则"
        description="累计实付充值扣除已记录退款后，按最高达标阶梯获得累计总名额，各档不相加。后台赠送余额和消费后的剩余余额不计入。"
      >
        <form onSubmit={savePolicy} className="space-y-4">
          <div className="space-y-3">
            {policyDraft.tiers.map((tier, index) => (
              <div
                key={index}
                className="grid items-end gap-3 rounded-lg border border-hairline bg-canvas p-3 sm:grid-cols-[auto_1fr_1fr_auto]"
              >
                <span className="text-[12px] text-muted sm:pb-3">
                  阶梯 {index + 1}
                </span>
                <AdminField label="累计净充值门槛（元）" required>
                  <AdminInput
                    type="number"
                    min="0.01"
                    max="1000000"
                    step="0.01"
                    required
                    aria-label={`阶梯 ${index + 1} 充值门槛`}
                    value={tier.threshold}
                    disabled={disabled || !policy}
                    onChange={(event) =>
                      setPolicyDraft((current) => ({
                        ...current,
                        tiers: current.tiers.map((item, position) =>
                          position === index
                            ? { ...item, threshold: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </AdminField>
                <AdminField label="累计总名额（个）" required>
                  <AdminInput
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    required
                    aria-label={`阶梯 ${index + 1} 累计总名额`}
                    value={tier.slots}
                    disabled={disabled || !policy}
                    onChange={(event) =>
                      setPolicyDraft((current) => ({
                        ...current,
                        tiers: current.tiers.map((item, position) =>
                          position === index
                            ? { ...item, slots: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </AdminField>
                <AdminSecondaryButton
                  icon={Trash2}
                  aria-label={`删除阶梯 ${index + 1}`}
                  disabled={
                    disabled || !policy || policyDraft.tiers.length <= 1
                  }
                  onClick={() =>
                    setPolicyDraft((current) => ({
                      ...current,
                      tiers: current.tiers.filter(
                        (_, position) => position !== index,
                      ),
                    }))
                  }
                >
                  删除
                </AdminSecondaryButton>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] leading-5 text-muted">
                门槛和累计总名额须依次递增，最多设置 10 个阶梯；升级只补足总名额的差额。
              </p>
              <AdminSecondaryButton
                icon={Plus}
                disabled={
                  disabled || !policy || policyDraft.tiers.length >= 10
                }
                onClick={() =>
                  setPolicyDraft((current) => ({
                    ...current,
                    tiers: [...current.tiers, { threshold: '', slots: '' }],
                  }))
                }
              >
                添加阶梯
              </AdminSecondaryButton>
            </div>
          </div>
          <div className="max-w-sm">
            <AdminField
              label="邀请码有效期（天）"
              hint="1–90 天；仅影响新生成的邀请码。"
              required
            >
              <AdminInput
                type="number"
                min="1"
                max="90"
                step="1"
                required
                value={policyDraft.days}
                disabled={disabled || !policy}
                onChange={(event) =>
                  setPolicyDraft((current) => ({
                    ...current,
                    days: event.target.value,
                  }))
                }
              />
            </AdminField>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
            <p className="max-w-2xl text-[12px] leading-5 text-muted">
              规则变更或退款降档会收回超额未用邀请码，优先撤销最新生成的码。已注册账号和人工调整保留；未达首档时不能继续邀请。
            </p>
            <AdminPrimaryButton
              type="submit"
              icon={Save}
              loading={busy === 'policy'}
              disabled={disabled || !policy}
            >
              保存邀请规则
            </AdminPrimaryButton>
          </div>
        </form>
      </Section>

      <Section
        title="用户邀请资格"
        description="输入用户 ID，查询净充值与名额。人工调整随阶梯变化保留，但仍要求用户达到首档充值门槛。"
      >
        <form onSubmit={lookupUser} className="flex flex-wrap items-end gap-2">
          <AdminField label="用户 ID" className="min-w-[200px] flex-1">
            <AdminInput
              value={query}
              required
              maxLength={100}
              placeholder="输入用户 ID"
              disabled={disabled}
              onChange={(event) => setQuery(event.target.value)}
            />
          </AdminField>
          <AdminPrimaryButton
            type="submit"
            icon={Search}
            disabled={disabled || !query.trim()}
          >
            查询用户
          </AdminPrimaryButton>
          {selectedUserId ? (
            <AdminSecondaryButton
              disabled={disabled}
              onClick={() => {
                setSelectedUserId('');
                setQuery('');
                setSummary(null);
                setViewAll(true);
              }}
            >
              清除查询
            </AdminSecondaryButton>
          ) : null}
        </form>
        {summary ? (
          <div className="mt-5 space-y-4 border-t border-hairline pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-[12px]">
                {summary.user_id}
              </span>
              <AdminStatusBadge
                tone={
                  summary.eligible
                    ? 'success'
                    : summary.suspended
                      ? 'warning'
                      : 'neutral'
                }
              >
                {summary.eligible
                  ? '已达标'
                  : summary.suspended
                    ? '邀请资格已暂停'
                    : '净充值未达标'}
              </AdminStatusBadge>
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {[
                ['累计净充值', `¥${summary.net_recharge_yuan.toFixed(2)}`],
                ['当前阶梯自动名额', summary.automatic_slots],
                [
                  '人工名额调整',
                  `${summary.manual_slot_adjustment > 0 ? '+' : ''}${summary.manual_slot_adjustment}`,
                ],
                ['累计总名额', summary.total_slots],
                [
                  '已用 / 已占用',
                  `${summary.used_slots} / ${summary.reserved_slots}`,
                ],
                ['可用名额', summary.available_slots],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-surface-card p-3">
                  <dt className="text-[11px] text-muted">{label}</dt>
                  <dd className="mt-1 text-lg tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <form onSubmit={saveUser} className="space-y-3">
              <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <AdminField
                  label="累计总名额（个）"
                  hint={`不能低于已用和已占用名额之和：${occupiedSlots}。修改总额会记为人工调整。`}
                  required
                >
                  <AdminInput
                    type="number"
                    min={occupiedSlots}
                    max="1000"
                    step="1"
                    required
                    value={totalSlots}
                    disabled={disabled}
                    onChange={(event) => setTotalSlots(event.target.value)}
                  />
                </AdminField>
                <label className="flex min-h-14 items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={suspended}
                    disabled={disabled}
                    onChange={(event) => setSuspended(event.target.checked)}
                  />
                  暂停用户邀请资格
                </label>
                <AdminPrimaryButton
                  type="submit"
                  icon={Save}
                  loading={busy === 'user'}
                  disabled={disabled}
                >
                  保存用户设置
                </AdminPrimaryButton>
              </div>
              <p className="text-[12px] leading-5 text-muted">
                退款降档后，总名额至少保留历史已用数量，不代表仍有可用名额。仅切换暂停状态不会改变人工调整。暂停后不能生成或使用用户邀请码，已注册账号保留。
              </p>
            </form>
          </div>
        ) : !selectedUserId ? (
          <p className="mt-3 text-[12px] text-muted">
            用户 ID 可在「用户」页面查找。
          </p>
        ) : null}
      </Section>

      <Section
        title="运营邀请码"
        description="运营邀请码不占用户邀请名额，仅限新用户注册时使用一次，赠送 72 小时体验会员。完整邀请码只返回一次，请及时复制。"
        action={
          <AdminPrimaryButton
            icon={Plus}
            loading={busy === 'create'}
            disabled={disabled || !!created}
            onClick={createInvite}
          >
            生成运营邀请码
          </AdminPrimaryButton>
        }
      >
        {created ? (
          <div className="space-y-3 rounded-lg border border-primary/25 bg-canvas p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
              <span>有效至 {formatTime(created.invite.expires_at)}</span>
              <span>尾号 {created.invite.code_suffix}</span>
            </div>
            {created.code ? (
              <>
                <div className="flex items-center gap-2">
                  <AdminInput
                    value={created.code}
                    readOnly
                    aria-label="新生成的运营邀请码"
                    className="font-mono"
                  />
                  <AdminSecondaryButton
                    icon={copied ? Check : Copy}
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => void copyCode()}
                  >
                    {copied ? '已复制' : '复制'}
                  </AdminSecondaryButton>
                </div>
                <p className="text-[12px] leading-5 text-muted">
                  收起或离开页面后无法再次查看完整邀请码。
                </p>
                <AdminSecondaryButton
                  disabled={!!busy}
                  onClick={() => setCreated(null)}
                >
                  我已保存，收起邀请码
                </AdminSecondaryButton>
              </>
            ) : (
              <>
                <p className="text-[13px] leading-6">
                  此邀请码已生成，完整邀请码无法再次获取。撤销后可重新生成。
                </p>
                <div className="flex flex-wrap gap-2">
                  <AdminSecondaryButton
                    icon={Ban}
                    disabled={disabled}
                    onClick={() => void revokeInvite(created.invite)}
                  >
                    撤销该邀请码
                  </AdminSecondaryButton>
                  <AdminSecondaryButton
                    disabled={!!busy}
                    onClick={() => setCreated(null)}
                  >
                    收起记录
                  </AdminSecondaryButton>
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-[12px] leading-5 text-muted">
            生成后可将邀请码发给新用户领取体验会员；邀请关系不会归到任何用户账号。不使用邀请码也可正常注册。
          </p>
        )}
        {createUncertain && actionError ? (
          <p className="mt-3 text-[12px] leading-5 text-muted">
            上次请求结果尚未确认，再次点击生成会查询同一次请求，避免重复发放。
          </p>
        ) : null}
      </Section>

      <Section
        title={filtered ? '当前用户的邀请码与退款记录' : '最近邀请码与退款记录'}
        description={
          filtered
            ? `当前筛选用户：${selectedUserId}`
            : '显示最近发放的运营与用户邀请码，以及最近登记的退款。'
        }
        action={
          selectedUserId ? (
            <AdminSecondaryButton
              disabled={disabled}
              onClick={() => setViewAll((current) => !current)}
            >
              {filtered ? '查看全部记录' : '只看当前用户'}
            </AdminSecondaryButton>
          ) : undefined
        }
      >
        <InviteList
          items={invitations}
          busy={disabled}
          onRevoke={(item) => void revokeInvite(item)}
        />
        <h3 className="mb-3 mt-5 text-[13px] font-medium">已完成退款记录</h3>
        {refunds.length ? (
          <div className="space-y-2">
            {refunds.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-hairline bg-canvas p-3 text-[12px]"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">
                    ¥{item.amount_yuan.toFixed(2)}
                  </span>
                  <span className="text-muted">
                    {formatTime(item.created_at)}
                  </span>
                </div>
                <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[72px_1fr]">
                  <dt className="text-muted">充值订单号</dt>
                  <dd className="break-all font-mono">{item.trade_id}</dd>
                  <dt className="text-muted">退款凭证号</dt>
                  <dd className="break-all font-mono">{item.reference}</dd>
                  <dt className="text-muted">备注</dt>
                  <dd className="break-words">{item.reason}</dd>
                </dl>
              </div>
            ))}
          </div>
        ) : (
          <AdminEmptyState title="暂无已完成退款记录" />
        )}
      </Section>

      <Section
        title="登记已完成退款"
        description="仅记录已在支付渠道完成的退款，用于重算邀请资格。"
      >
        <AdminAlert tone="warning">
          此操作不会发起退款，也不会调整钱包余额。请先在支付渠道完成退款，再登记实际退还金额；退款降档会收回超额未用邀请码，未达首档则撤销全部未用码。已注册账号和人工名额调整保留。
        </AdminAlert>
        <form onSubmit={recordRefund} className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminField
              label="原充值订单号（trade_id）"
              required
              hint="按订单所属用户计算邀请资格，请核对订单归属。"
            >
              <AdminInput
                value={refund.trade_id}
                maxLength={100}
                required
                disabled={disabled}
                onChange={(event) =>
                  setRefund((current) => ({
                    ...current,
                    trade_id: event.target.value,
                  }))
                }
              />
            </AdminField>
            <AdminField label="已完成退款金额（元）" required>
              <AdminInput
                type="number"
                min="0.01"
                max="1000000"
                step="0.01"
                value={refund.amount}
                required
                disabled={disabled}
                onChange={(event) =>
                  setRefund((current) => ({
                    ...current,
                    amount: event.target.value,
                  }))
                }
              />
            </AdminField>
            <AdminField
              label="退款凭证号"
              required
              hint="同一笔退款使用同一凭证号，重复提交不会重复记账。"
              className="sm:col-span-2"
            >
              <AdminInput
                value={refund.reference}
                maxLength={120}
                required
                disabled={disabled}
                onChange={(event) =>
                  setRefund((current) => ({
                    ...current,
                    reference: event.target.value,
                  }))
                }
              />
            </AdminField>
            <AdminField
              label="退款原因 / 核对备注"
              required
              className="sm:col-span-2"
            >
              <AdminTextarea
                value={refund.reason}
                maxLength={500}
                required
                disabled={disabled}
                onChange={(event) =>
                  setRefund((current) => ({
                    ...current,
                    reason: event.target.value,
                  }))
                }
              />
            </AdminField>
          </div>
          <label className="flex items-start gap-2 text-[12px] leading-5">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={refundConfirmed}
              required
              disabled={disabled}
              onChange={(event) => setRefundConfirmed(event.target.checked)}
            />
            <span>
              我已确认这笔退款在支付渠道完成，本次仅登记邀请资格账目。
            </span>
          </label>
          <AdminPrimaryButton
            type="submit"
            icon={Save}
            loading={busy === 'refund'}
            disabled={
              disabled ||
              !refundConfirmed ||
              !refund.trade_id.trim() ||
              !refund.reference.trim() ||
              !refund.reason.trim()
            }
          >
            登记已完成退款
          </AdminPrimaryButton>
        </form>
      </Section>
    </div>
  );
}
