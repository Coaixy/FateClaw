'use client';

import { useCallback, useEffect, useState } from 'react';
import { Crown, RefreshCw, Save } from 'lucide-react';

import {
  admin,
  type AdminMembershipConfigUpdate,
  type AdminMembershipPlanConfig,
} from '@/lib/admin-api';
import {
  AdminAlert,
  AdminEmptyState,
  AdminLoadingState,
  AdminPageHeader,
} from '@/components/ui/admin-states';
import {
  AdminField,
  AdminInput,
  AdminPrimaryButton,
  AdminStatusBadge,
} from '@/components/ui/admin-controls';

/**
 * 会员配置页：运营可视化调整卦师会员的月费 / 展示价 / 名称 / 上架状态。
 *
 * 单层化后实际只有 clarity 一档；用列表渲染保持对多档的前向兼容。
 * 改动经后端 PATCH 落库，无缓存层，用户端下次读取即生效。
 */
export default function AdminMembershipConfigPage() {
  const [plans, setPlans] = useState<AdminMembershipPlanConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await admin.membershipConfig();
      setPlans(res.plans);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 单条套餐保存成功后，用服务端返回值就地替换该卡片的数据。
  const handleSaved = (saved: AdminMembershipPlanConfig) => {
    setPlans((prev) =>
      prev.map((item) => (item.plan_key === saved.plan_key ? saved : item)),
    );
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <AdminPageHeader
        icon={Crown}
        title="会员配置"
        description="调整卦师会员的月费、展示价、名称与上架状态；保存后即时对用户端生效。"
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-10 items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted transition-colors hover:text-ink"
            title="刷新"
          >
            <RefreshCw size={13} />
            刷新
          </button>
        }
      />

      {error && <AdminAlert tone="error">{error}</AdminAlert>}

      {loading ? (
        <AdminLoadingState />
      ) : plans.length === 0 ? (
        <AdminEmptyState
          icon={Crown}
          title="暂无会员套餐配置"
          description="系统会在首次访问会员相关接口时自动初始化默认套餐。"
        />
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => (
            <MembershipPlanCard
              key={plan.plan_key}
              plan={plan}
              onSaved={handleSaved}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 单个会员套餐的编辑卡片。
 *
 * 维护本地可编辑草稿，做即时校验（非负、展示价不低于月费、名称非空），
 * 仅在有改动且校验通过时允许保存。
 *
 * @param plan 当前套餐配置（作为草稿初值，并在保存/刷新后重置草稿）。
 * @param onSaved 保存成功回调，回传服务端返回的最新套餐。
 */
function MembershipPlanCard({
  plan,
  onSaved,
}: {
  plan: AdminMembershipPlanConfig;
  onSaved: (saved: AdminMembershipPlanConfig) => void;
}) {
  const [name, setName] = useState(plan.name);
  const [monthly, setMonthly] = useState(String(plan.monthly_price_coins));
  const [display, setDisplay] = useState(String(plan.display_price_coins));
  const [enabled, setEnabled] = useState(plan.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  // 拿到新的 plan（刷新或保存后）时，用最新值重置可编辑草稿。
  useEffect(() => {
    setName(plan.name);
    setMonthly(String(plan.monthly_price_coins));
    setDisplay(String(plan.display_price_coins));
    setEnabled(plan.enabled);
  }, [plan]);

  const monthlyNum = Number(monthly);
  const displayNum = Number(display);
  const displayBelowMonthly =
    Number.isFinite(monthlyNum) &&
    Number.isFinite(displayNum) &&
    displayNum < monthlyNum;
  const invalid =
    name.trim().length === 0 ||
    !Number.isFinite(monthlyNum) ||
    monthlyNum < 0 ||
    !Number.isFinite(displayNum) ||
    displayNum < 0 ||
    displayBelowMonthly;

  // 是否相对服务端值有改动；无改动时禁用保存。
  const dirty =
    name !== plan.name ||
    monthlyNum !== plan.monthly_price_coins ||
    displayNum !== plan.display_price_coins ||
    enabled !== plan.enabled;

  const handleSave = async () => {
    if (invalid || !dirty || saving) return;
    setSaving(true);
    setError('');
    try {
      const patch: AdminMembershipConfigUpdate = {
        name: name.trim(),
        monthly_price_coins: monthlyNum,
        display_price_coins: displayNum,
        enabled,
      };
      const saved = await admin.updateMembershipConfig(plan.plan_key, patch);
      onSaved(saved);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-semibold">
            {plan.name || plan.plan_key}
          </h3>
          <AdminStatusBadge tone={enabled ? 'success' : 'neutral'}>
            {enabled ? '已上架' : '已下架'}
          </AdminStatusBadge>
        </div>
        <code className="shrink-0 text-[11px] text-muted-soft">
          {plan.plan_key}
        </code>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <AdminField label="套餐名称" required className="sm:col-span-2">
          <AdminInput
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </AdminField>
        <AdminField label="月费（积分）" hint="用户实际扣费" required>
          <AdminInput
            type="number"
            min={0}
            value={monthly}
            onChange={(event) => setMonthly(event.target.value)}
          />
        </AdminField>
        <AdminField label="展示价（积分）" hint="划线原价，需 ≥ 月费" required>
          <AdminInput
            type="number"
            min={0}
            value={display}
            onChange={(event) => setDisplay(event.target.value)}
          />
        </AdminField>
      </div>

      <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-body">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="h-4 w-4 rounded border-hairline accent-primary"
        />
        在售（用户端可见并可订阅）
      </label>

      {displayBelowMonthly && (
        <p className="mt-2 text-[12px] text-error">展示价不能低于月费。</p>
      )}
      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <AdminPrimaryButton
          icon={Save}
          loading={saving}
          disabled={invalid || !dirty}
          onClick={() => void handleSave()}
        >
          保存
        </AdminPrimaryButton>
        {!dirty && justSaved && (
          <span className="text-[12px] text-success">已保存</span>
        )}
      </div>
    </section>
  );
}
