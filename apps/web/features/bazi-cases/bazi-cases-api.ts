import type {
  BaziCaseDetailDto,
  BaziCaseListResponseDto,
  BaziCaseOverviewDto,
} from '@fateclaw/contracts/bazi-cases';

import { requestJson } from '@/lib/http/client';

/** 列表查询参数（前端侧，与后端 query 字段对齐）。 */
export interface BaziCaseListParams {
  gender?: string;
  marriage?: string;
  /** 按「当前」财富层级筛选。 */
  wealth?: string;
  education?: string;
  job_type?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/** 把参数对象拼成 query string，跳过空值。 */
function buildQuery(params: BaziCaseListParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/**
 * 八字命例数据集的公开查询 API（免登录；requestJson 在无 token 时自动不带鉴权头）。
 */
export const baziCasesApi = {
  /** 列表：筛选 + 分页。 */
  list: (params: BaziCaseListParams = {}) =>
    requestJson<BaziCaseListResponseDto>(`/api/bazi-cases${buildQuery(params)}`),
  /** 统计概览：各维度分布。 */
  overview: () => requestJson<BaziCaseOverviewDto>('/api/bazi-cases/overview'),
  /** 详情：命例 + 大运。 */
  detail: (id: number) =>
    requestJson<BaziCaseDetailDto>(`/api/bazi-cases/${id}`),
};
