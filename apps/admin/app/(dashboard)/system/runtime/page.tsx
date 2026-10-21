'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Save, Settings2 } from 'lucide-react';
import {
  RUNTIME_CONFIG_LIMITS,
  type RuntimeConfigDto,
} from '@fateclaw/contracts/model-settings';
import { admin } from '@/lib/admin-api';
import {
  AdminAlert,
  AdminLoadingState,
  AdminPageHeader,
} from '@/components/ui/admin-states';
import {
  AdminField,
  AdminInput,
  AdminPrimaryButton,
} from '@/components/ui/admin-controls';

type NumberKey = keyof typeof RUNTIME_CONFIG_LIMITS;
type Draft = Record<NumberKey, string>;
const groups: Array<{
  title: string;
  fields: Array<[NumberKey, string, string]>;
}> = [
  {
    title: '执行与进程',
    fields: [
      [
        'agent_concurrency_limit',
        '全局并发上限',
        '全站同时执行的 Agent 请求数量。',
      ],
      [
        'agent_account_concurrency',
        '单账号并发上限',
        '同一账号的 Agent 同时执行的请求数量。',
      ],
      [
        'local_agent_max_processes',
        '常驻进程上限',
        '同时保留的 Agent 进程数量；忙碌进程完成后再回收。',
      ],
      [
        'local_agent_idle_ttl_ms',
        '空闲回收时间（毫秒）',
        'Agent 空闲多久后释放进程。',
      ],
    ],
  },
  {
    title: '会话维护',
    fields: [
      [
        'pi_session_inactive_cleanup_days',
        '未活跃会话归档天数',
        '自动维护启用后，归档超过该天数未活跃的会话文件。',
      ],
      [
        'pi_session_orphan_grace_days',
        '孤儿文件保护天数',
        '管理员手动清理时，保留最近创建的孤儿文件。',
      ],
    ],
  },
  {
    title: 'Skill 容量',
    fields: [
      [
        'user_skill_max_count',
        '每人 Skill 数量上限',
        '限制用户新建的 Skill 数量。',
      ],
      [
        'skill_bundle_max_files',
        '单个 Skill 文件数上限',
        '限制一次保存的文件数量。',
      ],
      ['skill_bundle_max_file_chars', '单文件字数上限', '按字符数计算。'],
      [
        'skill_bundle_max_total_chars',
        '总字数上限',
        '不能低于单文件字数上限。',
      ],
      [
        'skill_bundle_max_zip_bytes',
        '导入 ZIP 大小上限（字节）',
        '限制浏览器导入的压缩包大小。',
      ],
    ],
  },
];

export default function RuntimeConfigPage() {
  const [saved, setSaved] = useState<RuntimeConfigDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [wechat, setWechat] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const accept = useCallback((config: RuntimeConfigDto) => {
    setSaved(config);
    setDraft(
      Object.fromEntries(
        Object.keys(RUNTIME_CONFIG_LIMITS).map((key) => [
          key,
          String(config[key as NumberKey]),
        ]),
      ) as Draft,
    );
    setWechat(config.wechat_claw_enabled);
    setMaintenance(config.pi_session_health_enabled);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      accept(await admin.runtimeConfig());
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载运行配置失败');
    } finally {
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    void load();
  }, [load]);

  const values = draft
    ? (Object.fromEntries(
        Object.entries(draft).map(([key, value]) => [key, Number(value)]),
      ) as Record<NumberKey, number>)
    : null;
  const invalid =
    !draft ||
    !values ||
    Object.entries(RUNTIME_CONFIG_LIMITS).some(([key, bounds]) => {
      const value = values[key as NumberKey];
      return (
        !draft[key as NumberKey].trim() ||
        !Number.isInteger(value) ||
        value < bounds.min ||
        value > bounds.max
      );
    }) ||
    values.skill_bundle_max_total_chars < values.skill_bundle_max_file_chars;
  const dirty =
    saved &&
    values &&
    (Object.keys(RUNTIME_CONFIG_LIMITS).some(
      (key) => values[key as NumberKey] !== saved[key as NumberKey],
    ) ||
      wechat !== saved.wechat_claw_enabled ||
      maintenance !== saved.pi_session_health_enabled);

  const save = async () => {
    if (!saved || !values || invalid || saving || !dirty) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      accept(
        await admin.updateRuntimeConfig({
          ...values,
          revision: saved.revision,
          wechat_claw_enabled: wechat,
          pi_session_health_enabled: maintenance,
        }),
      );
      setNotice(
        '已保存。并发约 2 秒内生效，进程参数应用于后续调度，微信约 10 秒内生效，自动维护约 1 分钟内生效。',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存运行配置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <AdminPageHeader
        icon={Settings2}
        title="运行配置"
        description="统一管理执行容量、会话维护、微信接入和 Skill 限额。"
        action={
          <button
            type="button"
            disabled={saving || loading}
            onClick={() => void load()}
            className="inline-flex h-10 items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={13} />
            刷新
          </button>
        }
      />
      {error && <AdminAlert tone="error">{error}</AdminAlert>}
      {notice && <AdminAlert tone="success">{notice}</AdminAlert>}
      {loading ? (
        <AdminLoadingState />
      ) : (
        saved &&
        draft && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving} className="space-y-4">
              <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-6">
                <h2 className="text-[15px] font-medium text-ink">服务开关</h2>
                <label className="mt-4 flex cursor-pointer items-start gap-3 text-[13px] text-body">
                  <input
                    type="checkbox"
                    checked={wechat}
                    onChange={(event) => setWechat(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span>
                    启用微信 Claw
                    <span className="mt-1 block text-[12px] text-muted">
                      默认关闭。开启后允许有效会员绑定；关闭后停止微信轮询，保留账号和历史会话。
                    </span>
                  </span>
                </label>
                <label className="mt-4 flex cursor-pointer items-start gap-3 text-[13px] text-body">
                  <input
                    type="checkbox"
                    checked={maintenance}
                    onChange={(event) => setMaintenance(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span>
                    自动维护会话文件
                    <span className="mt-1 block text-[12px] text-muted">
                      默认关闭。开启后每天归档已删除或长期未活跃的会话文件；孤儿文件仍需手动清理。
                    </span>
                  </span>
                </label>
              </section>
              {groups.map((group) => (
                <section
                  key={group.title}
                  className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-6"
                >
                  <h2 className="mb-4 text-[15px] font-medium text-ink">
                    {group.title}
                  </h2>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {group.fields.map(([key, label, description]) => (
                      <AdminField key={key} label={label}>
                        <AdminInput
                          type="number"
                          step={1}
                          min={RUNTIME_CONFIG_LIMITS[key].min}
                          max={RUNTIME_CONFIG_LIMITS[key].max}
                          required
                          value={draft[key]}
                          onChange={(event) =>
                            setDraft({ ...draft, [key]: event.target.value })
                          }
                          aria-label={label}
                        />
                        <span className="mt-1 block text-[12px] text-muted">
                          {description} 范围：
                          {RUNTIME_CONFIG_LIMITS[key].min.toLocaleString()}～
                          {RUNTIME_CONFIG_LIMITS[key].max.toLocaleString()}。
                        </span>
                      </AdminField>
                    ))}
                  </div>
                </section>
              ))}
            </fieldset>
            {invalid && (
              <p className="text-[12px] text-error">
                请填写范围内的整数，总字数上限不能小于单文件字数上限。
              </p>
            )}
            <AdminPrimaryButton
              type="submit"
              icon={Save}
              loading={saving}
              disabled={invalid || !dirty}
            >
              保存运行配置
            </AdminPrimaryButton>
          </form>
        )
      )}
    </div>
  );
}
