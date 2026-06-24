'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react';

import type {
  BaziCaseDto,
  BaziCaseDistributionItemDto,
  BaziCaseListResponseDto,
  BaziCaseOverviewDto,
  BaziFortuneDto,
} from '@fateclaw/contracts/bazi-cases';

import { AppShell } from '@/components/app-shell';
import {
  baziCasesApi,
  type BaziCaseListParams,
} from '@/features/bazi-cases/bazi-cases-api';
import {
  BaziPillars,
  charWuXing,
  WUXING_TEXT_CLASS,
  WuXingLegend,
} from '@/features/bazi-cases/bazi-pillars';

/** 列表每页条数。 */
const PAGE_SIZE = 12;

/** 当前生效的筛选条件（均为可选）。 */
interface Filters {
  gender?: string;
  marriage?: string;
  wealth?: string;
  education?: string;
  job_type?: string;
}

export default function BaziCasesPage() {
  const [overview, setOverview] = useState<BaziCaseOverviewDto | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BaziCaseListResponseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BaziCaseDto | null>(null);

  // 概览只加载一次；失败时静默（不阻塞列表）
  useEffect(() => {
    baziCasesApi
      .overview()
      .then(setOverview)
      .catch(() => undefined);
  }, []);

  // 搜索词防抖 300ms，并回到第一页
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // 筛选 / 搜索 / 翻页变化时拉列表
  useEffect(() => {
    const params: BaziCaseListParams = {
      ...filters,
      q: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    setLoading(true);
    setError(null);
    baziCasesApi
      .list(params)
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : '加载失败，请稍后重试'),
      )
      .finally(() => setLoading(false));
  }, [filters, debouncedSearch, page]);

  // 设置某个筛选字段并回到第一页
  const setField = (key: keyof Filters) => (value: string | undefined) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const hasActiveFilter =
    Boolean(search) || Object.values(filters).some(Boolean);

  const clearAll = () => {
    setFilters({});
    setSearch('');
    setPage(1);
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppShell requireAuth={false} wide>
      <div className="space-y-5">
        {/* 页头 */}
        <header>
          <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">
            八字命例库
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-muted sm:text-sm">
            1606 例真实命盘与其人生轨迹（出身 / 学历 / 婚姻 / 子女 / 财富起落 / 职业）。
            数据开放查询，无需登录，亦可通过开放 API 调用。
          </p>
        </header>

        {/* 筛选区：移动端搜索框独占一行 + 下拉两列网格；sm 及以上横排 */}
        <section className="space-y-2">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索职业 / 经历关键词"
              className="h-9 w-full rounded-lg border border-hairline bg-surface-card pl-8 pr-3 text-[12px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <FilterSelect
              label="性别"
              value={filters.gender}
              options={overview?.by_gender}
              onChange={setField('gender')}
            />
            <FilterSelect
              label="婚姻"
              value={filters.marriage}
              options={overview?.by_marriage}
              onChange={setField('marriage')}
            />
            <FilterSelect
              label="当前财富"
              value={filters.wealth}
              options={overview?.by_current_wealth}
              onChange={setField('wealth')}
            />
            <FilterSelect
              label="学历"
              value={filters.education}
              options={overview?.by_education}
              onChange={setField('education')}
            />
            <FilterSelect
              label="职业类型"
              value={filters.job_type}
              options={overview?.by_job_type}
              onChange={setField('job_type')}
            />
            {hasActiveFilter && (
              <button
                type="button"
                onClick={clearAll}
                className="col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-hairline bg-surface-card px-3 text-[12px] text-muted transition-colors hover:text-ink sm:col-auto"
              >
                <X size={13} />
                清除
              </button>
            )}
          </div>
        </section>

        {/* 结果统计 */}
        <div className="text-[12px] text-muted">
          {loading ? '加载中…' : `共 ${total} 条命例`}
        </div>

        {/* 列表 */}
        {loading ? (
          <div className="flex justify-center py-16 text-muted">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : error ? (
          <div className="py-16 text-center text-sm text-error">{error}</div>
        ) : !data || data.entries.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">
            没有符合条件的命例
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.entries.map((c) => (
              <CaseCard key={c.id} c={c} onClick={() => setSelected(c)} />
            ))}
          </div>
        )}

        {/* 分页 */}
        {total > PAGE_SIZE && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          />
        )}
      </div>

      {/* 详情 */}
      {selected && (
        <DetailModal c={selected} onClose={() => setSelected(null)} />
      )}
    </AppShell>
  );
}

/** 筛选下拉：选项与计数直接取自概览分布，始终与数据一致。 */
function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: BaziCaseDistributionItemDto[] | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="h-9 w-full rounded-lg border border-hairline bg-surface-card px-2.5 text-[12px] text-ink focus:border-primary focus:outline-none sm:w-auto"
    >
      <option value="">{label}·全部</option>
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value}（{o.count}）
        </option>
      ))}
    </select>
  );
}

/** 小标签。 */
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-surface-cream-strong px-1.5 py-0.5 text-[10px] text-muted">
      {children}
    </span>
  );
}

/** 命例卡片。 */
function CaseCard({ c, onClick }: { c: BaziCaseDto; onClick: () => void }) {
  const wealthFlow = [c.init_wealth, c.current_wealth].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface-card p-4 text-left transition-colors hover:border-primary/30"
    >
      <div className="flex items-start justify-between gap-2">
        <BaziPillars bazi={c.bazi} />
        <span className="shrink-0 text-[11px] tabular-nums text-muted">
          #{c.id}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge>{c.gender}</Badge>
        {c.marriage && <Badge>{c.marriage}</Badge>}
        {wealthFlow.length > 0 && (
          <Badge>
            {c.init_wealth ?? '—'} → {c.current_wealth ?? '—'}
          </Badge>
        )}
        {c.current_education && <Badge>{c.current_education}</Badge>}
      </div>
      <p className="line-clamp-2 text-[12px] leading-relaxed text-muted">
        {c.job ? `${c.job} · ` : ''}
        {c.job_info}
      </p>
    </button>
  );
}

/** 分页控件。 */
function Pagination({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      <button
        type="button"
        onClick={onPrev}
        disabled={page <= 1}
        className="inline-flex h-8 items-center gap-1 rounded-full border border-hairline bg-surface-card px-3 text-[12px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronLeft size={14} />
        上一页
      </button>
      <span className="inline-flex h-8 min-w-16 items-center justify-center rounded-full bg-surface-cream-strong px-3 text-[12px] tabular-nums text-ink">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages}
        className="inline-flex h-8 items-center gap-1 rounded-full border border-hairline bg-surface-card px-3 text-[12px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        下一页
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

/** 详情字段项。 */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="text-[11px] text-muted">{label}</span>
      <div className="mt-0.5 text-[13px] text-ink">{value ?? '—'}</div>
    </div>
  );
}

/** 数字字段格式化（null 显示破折号）。 */
function fmtNum(n: number | null): string {
  return n === null ? '—' : String(n);
}

/** 大运展示块：五行着色干支 + 起运虚岁 + 年龄区间。 */
function FortuneBlock({
  fortune,
}: {
  fortune: BaziFortuneDto | null | undefined;
}) {
  if (fortune === undefined) {
    return (
      <div className="rounded-xl border border-hairline bg-surface-card p-3 text-[12px] text-muted">
        大运计算中…
      </div>
    );
  }
  if (fortune === null) {
    return (
      <div className="rounded-xl border border-hairline bg-surface-card p-3 text-[12px] text-muted">
        大运数据缺失（原始数据无出生日期，未能反推）
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-hairline bg-surface-card p-3">
      <div className="mb-2 text-[11px] font-medium text-muted">
        大运 · {fortune.startAge} 岁起 · {fortune.isForward ? '顺排' : '逆排'}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {fortune.decades.map((d, i) => (
          <div
            key={i}
            className="flex flex-col items-center rounded-lg border border-hairline/60 bg-canvas px-2 py-1.5"
          >
            <span className="flex gap-0.5 text-[15px] font-semibold leading-none">
              {[...d.ganzhi].map((ch, j) => {
                const wx = charWuXing(ch);
                return (
                  <span
                    key={j}
                    className={wx ? WUXING_TEXT_CLASS[wx] : 'text-ink'}
                  >
                    {ch}
                  </span>
                );
              })}
            </span>
            <span className="mt-1 text-[10px] tabular-nums text-muted">
              {d.startAge}–{d.endAge}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-muted/70">
        起运岁数与干支序列基于八字推算；因原始数据无出生日期，仅给虚岁区间，不含公历年份。
      </p>
    </div>
  );
}

/** 命例详情弹窗。 */
function DetailModal({ c, onClose }: { c: BaziCaseDto; onClose: () => void }) {
  // 大运异步加载：undefined=加载中，null=无大运（反推失败）
  const [fortune, setFortune] = useState<BaziFortuneDto | null | undefined>(
    undefined,
  );

  useEffect(() => {
    let alive = true;
    baziCasesApi
      .detail(c.id)
      .then((d) => {
        if (alive) setFortune(d.fortune);
      })
      .catch(() => {
        if (alive) setFortune(null);
      });
    return () => {
      alive = false;
    };
  }, [c.id]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-hairline bg-canvas p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <BaziPillars bazi={c.bazi} size="lg" />
            <div className="mt-2.5">
              <WuXingLegend />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <FortuneBlock fortune={fortune} />

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="性别" value={c.gender} />
          <Field label="婚姻" value={c.marriage} />
          <Field label="子女" value={c.children_desc} />
          <Field label="堕胎" value={fmtNum(c.abortions_size)} />
          <Field label="子女夭折" value={fmtNum(c.child_deaths_size)} />
          <Field label="父母" value={c.current_parent} />
          <Field label="学历" value={c.current_education} />
          <Field label="出身财富" value={c.init_wealth} />
          <Field label="当前财富" value={c.current_wealth} />
          <Field label="职业类型" value={c.job_type} />
          <Field label="职业" value={c.job} />
        </div>

        {c.job_info && (
          <div className="mt-4 rounded-xl border border-hairline bg-surface-card p-3">
            <div className="mb-1.5 text-[11px] font-medium text-muted">
              人生轨迹
            </div>
            <p className="text-[13px] leading-relaxed text-body">
              {c.job_info}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
