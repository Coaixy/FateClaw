'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  admin,
  formatAdminErrorMessage,
  type AdminRedemptionCode,
  type AdminRedemptionCodeStats,
  type AdminRedemptionCodeStatus,
} from '@/lib/admin-api';
import { formatCoins } from '@/lib/soft-currency';
import { toAdminDocumentHref } from '@/lib/admin-navigation';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';
import {
  AdminAlert,
  AdminFilterSection,
  AdminLoadingState,
  AdminPageHeader,
  AdminPagination,
} from '@/components/ui/admin-states';
import { AdminCopyButton } from '@/components/ui/admin-controls';
import { AdminSearchInput } from '@/components/ui/admin-search';
import {
  AdminActiveFilters,
  type AdminFilterChipData,
} from '@/components/ui/admin-filter-chips';
import { Ticket, Plus, BarChart3, Ban, Filter, Copy, Download } from 'lucide-react';

const PAGE_SIZE = 20;

/**
 * 单次"导出筛选全量"的硬顶，防管理员误筛出超大批量拖垮数据库。
 *
 * 兑换码通常按批次生成、单批不超 1000，5000 足以覆盖多批合并导出场景；
 * 超过时导出截断并在 toast 里告知真实总数，引导用户收窄筛选。
 */
const EXPORT_HARD_CAP = 5000;

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '未使用' },
  { value: 'redeemed', label: '已兑换' },
  { value: 'expired', label: '已过期' },
  { value: 'revoked', label: '已撤销' },
] as const;

const AMOUNT_PRESETS = [5, 10, 30, 50, 100];

/**
 * 从当前 URL 读取初始筛选/分页值，支持刷新保留与查询链接分享。
 *
 * 与 billing 页同构：status 默认 'all'，page 用 1-based 入参转 0-based，
 * 文本维度（batch_id/code）默认空串，amount 必须落在 AMOUNT_PRESETS 内。
 */
function readInitialRedemptionQuery(name: string) {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) || '';
}

function readInitialRedemptionStatus(): 'all' | AdminRedemptionCodeStatus {
  const value = readInitialRedemptionQuery('status');
  return STATUS_OPTIONS.some((opt) => opt.value === value && value !== 'all')
    ? (value as AdminRedemptionCodeStatus)
    : 'all';
}

function readInitialRedemptionPage() {
  const value = Number(readInitialRedemptionQuery('page'));
  return Number.isInteger(value) && value > 0 ? value - 1 : 0;
}

/**
 * 把当前筛选/分页写回 URL（replaceState，不触发导航）。
 *
 * 清除默认值不写入查询串，保持 URL 简洁；写回后刷新仍可恢复筛选状态。
 * 各维度与读取时一一对应，避免 URL 与 state 语义错位。
 */
function replaceRedemptionQuery(input: {
  status: 'all' | AdminRedemptionCodeStatus;
  page: number;
  batchId: string;
  amount: 'all' | number;
  createdAfter: string;
  createdBefore: string;
  codeSearch: string;
}) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (input.status !== 'all') params.set('status', input.status);
  if (input.page > 0) params.set('page', String(input.page + 1));
  if (input.batchId.trim()) params.set('batch_id', input.batchId.trim());
  if (input.amount !== 'all') params.set('amount', String(input.amount));
  if (input.createdAfter) params.set('created_after', input.createdAfter);
  if (input.createdBefore) params.set('created_before', input.createdBefore);
  if (input.codeSearch.trim()) params.set('code', input.codeSearch.trim());
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    toAdminDocumentHref(`/billing/redemption-codes${query ? `?${query}` : ''}`),
  );
}

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shortId(value: string | null | undefined) {
  if (!value) return '—';
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function statusLabel(status: AdminRedemptionCodeStatus) {
  if (status === 'pending') return '未使用';
  if (status === 'redeemed') return '已兑换';
  if (status === 'expired') return '已过期';
  if (status === 'revoked') return '已撤销';
  return status;
}

function StatusBadge({
  status,
}: {
  status: AdminRedemptionCodeStatus;
}) {
  const className =
    status === 'pending'
      ? 'border-blue-500/25 bg-blue-500/8 text-blue-700'
      : status === 'redeemed'
        ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700'
        : status === 'expired'
          ? 'border-amber-500/25 bg-amber-500/10 text-amber-700'
          : 'border-gray-500/25 bg-gray-500/10 text-gray-700';

  return (
    <span
      className={`inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-medium ${className}`}
    >
      {statusLabel(status)}
    </span>
  );
}

export default function RedemptionCodesPage() {
  const [loading, setLoading] = useState(true);
  const [codes, setCodes] = useState<AdminRedemptionCode[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<AdminRedemptionCodeStats | null>(null);
  const [page, setPage] = useState(() => readInitialRedemptionPage());
  const [status, setStatus] = useState<'all' | AdminRedemptionCodeStatus>(
    () => readInitialRedemptionStatus(),
  );
  // 批次搜索：文本片段，防抖后再发给后端，与 billing 页 userId 同节奏。
  const [batchId, setBatchId] = useState(() => readInitialRedemptionQuery('batch_id'));
  // 面额：精确匹配预设值，'all' 表示不限。
  const [amount, setAmount] = useState<'all' | number>(() => {
    const value = Number(readInitialRedemptionQuery('amount'));
    return AMOUNT_PRESETS.includes(value) ? value : 'all';
  });
  // 创建时间区间：YYYY-MM-DD 字符串，留空表示该端不限。
  const [createdAfter, setCreatedAfter] = useState(() =>
    readInitialRedemptionQuery('created_after'),
  );
  const [createdBefore, setCreatedBefore] = useState(() =>
    readInitialRedemptionQuery('created_before'),
  );
  // 卡密码搜索：文本片段，同 batchId 用防抖避免逐字符打接口。
  const [codeSearch, setCodeSearch] = useState(() =>
    readInitialRedemptionQuery('code'),
  );
  const [error, setError] = useState('');

  // 生成卡密表单
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [generateCount, setGenerateCount] = useState(1);
  const [generateAmount, setGenerateAmount] = useState(10);
  const [generateNote, setGenerateNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [showGeneratedCodes, setShowGeneratedCodes] = useState(false);
  // 导出当前筛选全量：循环分页拉取过程中的进度与防重入。
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const exportingRef = useRef(false);

  const { toast } = useToast();
  const { confirm } = useConfirm();

  // 文本搜索类筛选防抖（400ms，与 billing 页 userId 同节奏），下拉类筛选立即生效。
  const debouncedBatchId = useDebouncedValue(batchId, 400);
  const debouncedCode = useDebouncedValue(codeSearch, 400);

  // 创建时间区间端点转 ISO：
  // created_after 用当天 00:00:00 作为闭区间起点；
  // created_before 用次日 00:00:00 作为开区间终点（repo 用 < 比较），自然覆盖整天不被秒级漏。
  const createdAfterIso = useMemo(() => {
    if (!createdAfter) return undefined;
    const d = new Date(`${createdAfter}T00:00:00`);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }, [createdAfter]);
  const createdBeforeIso = useMemo(() => {
    if (!createdBefore) return undefined;
    // 次日 00:00:00：在用户选的日期上 +1 天
    const d = new Date(`${createdBefore}T00:00:00`);
    if (Number.isNaN(d.getTime())) return undefined;
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  }, [createdBefore]);

  const loadCodes = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await admin.listRedemptionCodes({
        status: status === 'all' ? undefined : status,
        batchId: debouncedBatchId.trim() || undefined,
        amountCoins: amount === 'all' ? undefined : amount,
        code: debouncedCode.trim() || undefined,
        createdAfter: createdAfterIso,
        createdBefore: createdBeforeIso,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setCodes(response.codes);
      setTotal(response.total);
    } catch (err) {
      setError(formatAdminErrorMessage(err, '加载卡密列表失败'));
    } finally {
      setLoading(false);
    }
  }, [
    amount,
    createdAfterIso,
    createdBeforeIso,
    debouncedBatchId,
    debouncedCode,
    page,
    status,
  ]);

  const loadStats = useCallback(async () => {
    try {
      const statsData = await admin.getRedemptionCodeStats();
      setStats(statsData);
    } catch (err) {
      console.error('加载统计失败:', err);
    }
  }, []);

  useEffect(() => {
    loadCodes();
    loadStats();
  }, [loadCodes, loadStats]);

  // 筛选/分页变化即写回 URL：刷新保留、可分享查询链接（修复此前无 URL 同步的 bug）。
  useEffect(() => {
    replaceRedemptionQuery({
      status,
      page,
      batchId,
      amount,
      createdAfter,
      createdBefore,
      codeSearch,
    });
  }, [status, page, batchId, amount, createdAfter, createdBefore, codeSearch]);

  // 生效筛选 chip：5 个维度各自展示可单删的标签。
  // 任意筛选变化都需把分页拨回首页（page 索引越界时后端返回空），
  // 用 resetPage 统一保证 clear 动作不丢这一步。
  const resetPage = useCallback(() => setPage(0), []);
  const activeFilterChips: AdminFilterChipData[] = useMemo(() => {
    const chips: AdminFilterChipData[] = [];
    if (status !== 'all') {
      chips.push({
        key: 'status',
        label: `状态：${statusLabel(status)}`,
        onClear: () => {
          setStatus('all');
          resetPage();
        },
      });
    }
    if (batchId.trim()) {
      chips.push({
        key: 'batch_id',
        label: `批次：${batchId.trim()}`,
        onClear: () => {
          setBatchId('');
          resetPage();
        },
      });
    }
    if (amount !== 'all') {
      chips.push({
        key: 'amount',
        label: `面额：${formatCoins(amount)}`,
        onClear: () => {
          setAmount('all');
          resetPage();
        },
      });
    }
    if (createdAfter || createdBefore) {
      // 区间用单个 chip 展示，clear 一次清两端，避免给两端各贴一个标签。
      const range = `${createdAfter || '…'} ~ ${createdBefore || '今'}`;
      chips.push({
        key: 'created_range',
        label: `创建：${range}`,
        onClear: () => {
          setCreatedAfter('');
          setCreatedBefore('');
          resetPage();
        },
      });
    }
    if (codeSearch.trim()) {
      chips.push({
        key: 'code',
        label: `卡密码：${codeSearch.trim()}`,
        onClear: () => {
          setCodeSearch('');
          resetPage();
        },
      });
    }
    return chips;
  }, [status, batchId, amount, createdAfter, createdBefore, codeSearch, resetPage]);

  // 清空全部：把 5 个筛选维度重置为默认并重置分页。
  const clearAllFilters = useCallback(() => {
    setStatus('all');
    setBatchId('');
    setAmount('all');
    setCreatedAfter('');
    setCreatedBefore('');
    setCodeSearch('');
    resetPage();
  }, [resetPage]);

  const handleGenerate = async () => {
    if (generateCount < 1 || generateCount > 1000) {
      toast('error', '生成数量必须在 1-1000 之间');
      return;
    }
    if (generateAmount <= 0) {
      toast('error', '面额必须大于 0');
      return;
    }

    try {
      setGenerating(true);
      const response = await admin.generateRedemptionCodes({
        count: generateCount,
        amountCoins: generateAmount,
        note: generateNote || undefined,
        expiresAt: null,
      });

      // 保存生成的卡密码列表
      setGeneratedCodes(response.codes.map((c) => c.code));
      setShowGeneratedCodes(true);

      toast('success', `成功生成 ${response.codes.length} 个卡密`);
      setShowGenerateForm(false);
      setGenerateCount(1);
      setGenerateNote('');
      loadCodes();
      loadStats();
    } catch (err) {
      toast('error', formatAdminErrorMessage(err, '生成卡密失败'));
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (code: AdminRedemptionCode) => {
    const confirmed = await confirm({
      title: `确定要撤销卡密 ${code.code} 吗？`,
      message: '撤销后该卡密将无法使用',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await admin.revokeRedemptionCode(code.id);
      toast('success', '卡密已撤销');
      loadCodes();
      loadStats();
    } catch (err) {
      toast('error', formatAdminErrorMessage(err, '撤销卡密失败'));
    }
  };

  const handleCopyAllCodes = () => {
    const text = generatedCodes.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      toast('success', '已复制全部卡密到剪贴板');
    }).catch(() => {
      toast('error', '复制失败');
    });
  };

  const handleDownloadCodes = () => {
    const text = generatedCodes.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redemption-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('success', '已下载卡密文件');
  };

  /**
   * 导出当前筛选条件下的全部卡密为 TXT（每行一个卡密码）。
   *
   * 与列表请求共用同一组"已应用筛选"（防抖值 + ISO 区间），确保导出内容与
   * 用户屏幕看到的筛选一致。循环分页拉取，offset 累加至 total 终止；
   * EXPORT_HARD_CAP 硬顶防管理员误筛出超大批量拖垮库。
   */
  const handleExportFiltered = async () => {
    // 防重入：连点导出按钮只跑一次。
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setExportProgress('准备导出…');
    try {
      const LIMIT = 100;
      let offset = 0;
      const collected: string[] = [];
      // 先取第一页拿 total，后续按 total 决定还要拉几批。
      const first = await admin.listRedemptionCodes({
        status: status === 'all' ? undefined : status,
        batchId: debouncedBatchId.trim() || undefined,
        amountCoins: amount === 'all' ? undefined : amount,
        code: debouncedCode.trim() || undefined,
        createdAfter: createdAfterIso,
        createdBefore: createdBeforeIso,
        limit: LIMIT,
        offset: 0,
      });
      collected.push(...first.codes.map((c) => c.code));
      const totalToFetch = Math.min(first.total, EXPORT_HARD_CAP);
      setExportProgress(`已拉取 ${collected.length} / ${totalToFetch}`);
      while (collected.length < totalToFetch) {
        offset += LIMIT;
        const batch = await admin.listRedemptionCodes({
          status: status === 'all' ? undefined : status,
          batchId: debouncedBatchId.trim() || undefined,
          amountCoins: amount === 'all' ? undefined : amount,
          code: debouncedCode.trim() || undefined,
          createdAfter: createdAfterIso,
          createdBefore: createdBeforeIso,
          limit: LIMIT,
          offset,
        });
        if (batch.codes.length === 0) break;
        collected.push(...batch.codes.map((c) => c.code));
        setExportProgress(`已拉取 ${collected.length} / ${totalToFetch}`);
      }
      const truncated = collected.length < first.total;
      const text = collected.join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `redemption-codes-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (truncated) {
        toast(
          'success',
          `已导出 ${collected.length} 条（总计 ${first.total} 条，受单次导出上限 ${EXPORT_HARD_CAP} 截断）`,
        );
      } else {
        toast('success', `已导出 ${collected.length} 条卡密`);
      }
    } catch (err) {
      toast('error', formatAdminErrorMessage(err, '导出失败'));
    } finally {
      exportingRef.current = false;
      setExporting(false);
      setExportProgress(null);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        icon={Ticket}
        title="卡密充值管理"
        description="生成和管理卡密充值码"
        action={
          <button
            onClick={() => setShowGenerateForm(true)}
            className="flex h-10 items-center gap-2 rounded-lg bg-[#C4612F] px-6 text-sm font-semibold text-white shadow-sm hover:bg-[#A94E22] transition-colors"
          >
            <Plus className="h-5 w-5" />
            生成卡密
          </button>
        }
      />

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-hairline bg-canvas p-4">
            <div className="flex items-center gap-2 text-sm text-muted">
              <BarChart3 className="h-4 w-4" />
              <span>总卡密数</span>
            </div>
            <div className="mt-2 text-2xl font-semibold">{stats.totalCount}</div>
          </div>
          <div className="rounded-lg border border-hairline bg-canvas p-4">
            <div className="text-sm text-muted">未使用</div>
            <div className="mt-2 text-2xl font-semibold text-blue-600">
              {stats.pendingCount}
            </div>
          </div>
          <div className="rounded-lg border border-hairline bg-canvas p-4">
            <div className="text-sm text-muted">已兑换</div>
            <div className="mt-2 text-2xl font-semibold text-emerald-600">
              {stats.redeemedCount}
            </div>
          </div>
          <div className="rounded-lg border border-hairline bg-canvas p-4">
            <div className="text-sm text-muted">已兑换金额</div>
            <div className="mt-2 text-2xl font-semibold">
              {formatCoins(stats.redeemedAmountCoins)}
            </div>
          </div>
        </div>
      )}

      {/* 筛选区：独占一行，不再与"生成卡密"按钮共享操作栏（查询与创建语义分离）。 */}
      <AdminFilterSection icon={Filter} title="筛选">
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">卡密码</span>
            <AdminSearchInput
              value={codeSearch}
              onValueChange={(value) => {
                setCodeSearch(value);
                resetPage();
              }}
              onClear={() => {
                setCodeSearch('');
                resetPage();
              }}
              placeholder="片段搜索（防抖）"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">批次 ID</span>
            <AdminSearchInput
              value={batchId}
              onValueChange={(value) => {
                setBatchId(value);
                resetPage();
              }}
              onClear={() => {
                setBatchId('');
                resetPage();
              }}
              placeholder="精确批次 ID（防抖）"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">状态</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                resetPage();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-primary/45"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">面额（积分）</span>
            <select
              value={amount}
              onChange={(e) => {
                const value = e.target.value;
                setAmount(value === 'all' ? 'all' : Number(value));
                resetPage();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-primary/45"
            >
              <option value="all">全部面额</option>
              {AMOUNT_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {formatCoins(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">创建起（含）</span>
            <input
              type="date"
              value={createdAfter}
              onChange={(e) => {
                setCreatedAfter(e.target.value);
                resetPage();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-primary/45"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">创建止（含）</span>
            <input
              type="date"
              value={createdBefore}
              onChange={(e) => {
                setCreatedBefore(e.target.value);
                resetPage();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-primary/45"
            />
          </label>
        </div>
        <AdminActiveFilters
          chips={activeFilterChips}
          onClear={clearAllFilters}
        />
      </AdminFilterSection>

      {/* 生成表单 */}
      {showGenerateForm && (
        <div className="rounded-lg border border-hairline bg-canvas p-6">
          <h3 className="mb-4 text-lg font-semibold">批量生成卡密</h3>
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-semibold text-ink">
                数量（1-1000）
              </label>
              <input
                type="number"
                min="1"
                max="1000"
                value={generateCount}
                onChange={(e) => setGenerateCount(Number(e.target.value))}
                className="h-11 w-full rounded-lg border-2 border-hairline bg-white px-4 text-sm font-medium text-ink focus:border-[#C4612F] focus:outline-none transition-colors"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-semibold text-ink">面额</label>
              <div className="flex flex-wrap gap-2">
                {AMOUNT_PRESETS.map((amount) => (
                  <button
                    key={amount}
                    onClick={() => setGenerateAmount(amount)}
                    className={`h-10 rounded-lg border-2 px-5 text-sm font-semibold transition-all ${
                      generateAmount === amount
                        ? 'border-[#C4612F] bg-[#C4612F] text-white shadow-sm'
                        : 'border-hairline bg-white text-ink hover:border-[#C4612F] hover:text-[#C4612F]'
                    }`}
                  >
                    {amount} 元
                  </button>
                ))}
              </div>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={generateAmount}
                onChange={(e) => setGenerateAmount(Number(e.target.value))}
                className="mt-2 h-11 w-full rounded-lg border-2 border-hairline bg-white px-4 text-sm font-medium text-ink focus:border-[#C4612F] focus:outline-none transition-colors"
                placeholder="或输入自定义金额"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-semibold text-ink">
                备注（可选）
              </label>
              <input
                type="text"
                value={generateNote}
                onChange={(e) => setGenerateNote(e.target.value)}
                className="h-11 w-full rounded-lg border-2 border-hairline bg-white px-4 text-sm font-medium text-ink focus:border-[#C4612F] focus:outline-none transition-colors"
                placeholder="如：春节活动、会员福利等"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="h-10 rounded-lg bg-[#C4612F] px-6 text-sm font-semibold text-white shadow-sm hover:bg-[#A94E22] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {generating ? '生成中...' : '确认生成'}
              </button>
              <button
                onClick={() => setShowGenerateForm(false)}
                disabled={generating}
                className="h-10 rounded-lg border-2 border-hairline bg-white px-6 text-sm font-semibold text-ink hover:bg-surface transition-colors disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 生成成功后显示卡密列表 */}
      {showGeneratedCodes && generatedCodes.length > 0 && (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h3 className="text-xl font-bold text-emerald-700">
                ✓ 生成成功！共 {generatedCodes.length} 个卡密
              </h3>
              <p className="mt-1.5 text-sm font-medium text-emerald-600">
                请及时保存或复制这些卡密，关闭后将无法再次查看完整列表
              </p>
            </div>
            <button
              onClick={() => setShowGeneratedCodes(false)}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
            >
              关闭
            </button>
          </div>

          <div className="mb-4 flex gap-3">
            <button
              onClick={handleCopyAllCodes}
              className="flex h-10 items-center gap-2 rounded-lg border-2 border-emerald-500/30 bg-white px-5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 transition-colors"
            >
              <Copy className="h-4 w-4" />
              复制全部
            </button>
            <button
              onClick={handleDownloadCodes}
              className="flex h-10 items-center gap-2 rounded-lg border-2 border-emerald-500/30 bg-white px-5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 transition-colors"
            >
              <Download className="h-4 w-4" />
              下载为文件
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto rounded-lg border-2 border-emerald-500/30 bg-white p-4">
            <div className="grid gap-3 font-mono text-sm">
              {generatedCodes.map((code, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between rounded-lg border-2 border-hairline bg-surface px-4 py-3 hover:border-emerald-500/30 transition-colors"
                >
                  <span className="text-base font-semibold text-ink">{code}</span>
                  <AdminCopyButton text={code} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && <AdminAlert tone="error">{error}</AdminAlert>}

      {/* 导出工具行：把当前筛选下的全部卡密导出为 TXT（每行一个）。 */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleExportFiltered()}
          disabled={exporting || total === 0}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface-card px-3.5 text-[13px] font-medium text-body transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Download size={13} />
          {exporting ? (exportProgress ?? '导出中…') : `导出筛选结果${total > 0 ? `（共 ${total} 条）` : ''}`}
        </button>
        {exporting ? (
          <span className="text-[12px] text-muted">
            正在按当前筛选分批拉取卡密，请勿离开页面…
          </span>
        ) : null}
      </div>

      {loading ? (
        <AdminLoadingState />
      ) : codes.length === 0 ? (
        <div className="rounded-lg border border-hairline bg-canvas p-8 text-center text-muted">
          暂无卡密记录
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-hairline">
            <table className="w-full">
              <thead className="bg-surface text-left text-sm font-medium text-muted">
                <tr>
                  <th className="px-4 py-3">卡密码</th>
                  <th className="px-4 py-3">面额</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-4 py-3">备注</th>
                  <th className="px-4 py-3">兑换者</th>
                  <th className="px-4 py-3">创建时间</th>
                  <th className="px-4 py-3">操作</th>
                </tr>
              </thead>
              <tbody className="bg-canvas text-sm">
                {codes.map((code) => (
                  <tr key={code.id} className="border-t border-hairline">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs">{code.code}</code>
                        <AdminCopyButton text={code.code} />
                      </div>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {formatCoins(code.amount_coins)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={code.status} />
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {code.note || '—'}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {code.redeemed_by ? shortId(code.redeemed_by) : '—'}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {formatDateTime(code.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      {code.status === 'pending' && (
                        <button
                          onClick={() => handleRevoke(code)}
                          className="flex items-center gap-1 text-sm text-error hover:underline"
                        >
                          <Ban className="h-3 w-3" />
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <AdminPagination
              rangeLabel={`${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, total)} / ${total}`}
              pageLabel={`第 ${page + 1} / ${totalPages} 页`}
              canPrevious={page > 0}
              canNext={page < totalPages - 1}
              disabled={loading}
              onPrevious={() => setPage(page - 1)}
              onNext={() => setPage(page + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}
