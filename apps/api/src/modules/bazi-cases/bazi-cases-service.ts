import type {
  BaziCaseDetailDto,
  BaziCaseDto,
  BaziCaseListResponseDto,
  BaziCaseOverviewDto,
  BaziFortuneDto,
} from '@fateclaw/contracts/bazi-cases';

import { runBaziPaipan } from '../chat/paipan-runners/bazi.js';
import {
  getBaziCaseById,
  getBaziCasesOverview,
  listBaziCasesPage,
  type BaziCaseRow,
  type BaziCasesOverview,
} from '../../infrastructure/db.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';

/** 列表默认每页条数。 */
const DEFAULT_LIMIT = 20;
/** 单页上限，防止一次性拉走过多数据（开放 API 的基础防爬）。 */
const MAX_LIMIT = 100;
/** 关键词最大长度，防止超长串触发 job/job_info 的 ILIKE 全表慢扫。 */
const MAX_QUERY_LENGTH = 64;

/** 命例表行 → 对外 DTO（字段 1:1）。 */
function toDto(row: BaziCaseRow): BaziCaseDto {
  return {
    id: row.id,
    bazi: row.bazi,
    gender: row.gender,
    marriage: row.marriage,
    children_desc: row.children_desc,
    abortions_size: row.abortions_size,
    child_deaths_size: row.child_deaths_size,
    current_education: row.current_education,
    current_parent: row.current_parent,
    init_wealth: row.init_wealth,
    current_wealth: row.current_wealth,
    job: row.job,
    job_type: row.job_type,
    job_info: row.job_info,
  };
}

/** limit 兜底并夹在 [1, MAX_LIMIT]。非法/缺省回退默认值。 */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const n = Math.trunc(raw);
  if (n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** 列表查询入参（来自 HTTP query，已是解析后的可选值）。 */
export interface ListBaziCasesInput {
  gender?: string;
  marriage?: string;
  wealth?: string;
  education?: string;
  jobType?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * 分页 + 筛选查询命例列表。
 */
export async function listBaziCases(
  input: ListBaziCasesInput,
): Promise<ServiceResult<BaziCaseListResponseDto>> {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0) || 0);

  const page = await listBaziCasesPage({
    gender: input.gender,
    marriage: input.marriage,
    wealth: input.wealth,
    education: input.education,
    jobType: input.jobType,
    q: input.q?.slice(0, MAX_QUERY_LENGTH),
    limit,
    offset,
  });

  return ok({
    entries: page.rows.map(toDto),
    total: page.total,
    limit,
    offset,
  });
}

/** 内部统计结构 → 对外概览 DTO。 */
function toOverviewDto(overview: BaziCasesOverview): BaziCaseOverviewDto {
  return {
    total: overview.total,
    by_gender: overview.byGender,
    by_marriage: overview.byMarriage,
    by_job_type: overview.byJobType,
    by_education: overview.byEducation,
    by_init_wealth: overview.byInitWealth,
    by_current_wealth: overview.byCurrentWealth,
  };
}

/**
 * 统计概览：各维度取值分布 + 总数。
 */
export async function getBaziCasesOverviewService(): Promise<
  ServiceResult<BaziCaseOverviewDto>
> {
  const overview = await getBaziCasesOverview();
  return ok(toOverviewDto(overview));
}

/**
 * 用反推阳历生日计算大运（复用现有八字排盘 runner）。
 * 排盘失败时返回 null，不阻断详情返回。
 */
async function computeFortune(
  solarDate: string,
  solarHour: number,
  gender: string,
): Promise<BaziFortuneDto | null> {
  try {
    const result = await runBaziPaipan({
      solarDate,
      hour: solarHour,
      gender,
      include: ['fortune'],
    });
    const fortune = result.fortune;
    if (!fortune) return null;
    // decades 首项是「小运」(index -1)，过滤掉只保留真正的大运
    const decades = fortune.decades
      .filter((d) => d.index >= 0)
      .map((d) => ({
        ganzhi: d.sixtyCycle,
        startAge: d.startAge,
        endAge: d.endAge,
      }));
    return {
      startAge: fortune.childLimit.startAge,
      isForward: fortune.childLimit.isForward,
      decades,
    };
  } catch {
    return null;
  }
}

/**
 * 命例详情：命例字段 + 大运（仅当有反推阳历生日时才算）。
 */
export async function getBaziCaseDetail(
  id: number,
): Promise<ServiceResult<BaziCaseDetailDto>> {
  const row = await getBaziCaseById(id);
  if (!row) return fail(404, '命例不存在');
  const fortune =
    row.solar_date && row.solar_hour !== null
      ? await computeFortune(row.solar_date, row.solar_hour, row.gender)
      : null;
  return ok({ ...toDto(row), fortune });
}
