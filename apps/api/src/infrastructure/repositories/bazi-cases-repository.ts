import { getDbPool } from '../db-pool.js';

/** bazi_cases 表行（字段名与列名一致，snake_case）。 */
export interface BaziCaseRow {
  id: number;
  bazi: string;
  gender: string;
  marriage: string | null;
  children_desc: string | null;
  abortions_size: number | null;
  child_deaths_size: number | null;
  current_education: string | null;
  current_parent: string | null;
  init_wealth: string | null;
  current_wealth: string | null;
  job: string | null;
  job_type: string | null;
  job_info: string | null;
}

/** 命例表完整列清单。 */
const BAZI_CASE_SELECT_COLUMNS = `
  id, bazi, gender, marriage, children_desc,
  abortions_size, child_deaths_size, current_education, current_parent,
  init_wealth, current_wealth, job, job_type, job_info
`;

/** 列表查询参数：筛选维度 + 分页（limit/offset 由 service 兜底）。 */
export interface ListBaziCasesParams {
  gender?: string;
  marriage?: string;
  /** 按「当前」财富层级筛选。 */
  wealth?: string;
  education?: string;
  jobType?: string;
  /** 关键词：在 job / job_info 子串匹配。 */
  q?: string;
  limit: number;
  offset: number;
}

/** 列表查询结果：当前页行 + 当前筛选条件下的命中总数。 */
export interface BaziCasesPage {
  rows: BaziCaseRow[];
  total: number;
}

/**
 * 分页查询命例，支持按性别/婚姻/财富/学历/职业类型筛选与关键词搜索。
 *
 * @remarks 用 COUNT(*) OVER() 在同一查询内取总数（与项目内 listUsersPageForAdmin 同款写法）；
 *          当 offset 越界导致结果为空时总数回退为 0，正常分页不会触发。
 */
export async function listBaziCasesPage(
  params: ListBaziCasesParams,
): Promise<BaziCasesPage> {
  const where: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (params.gender) {
    where.push(`gender = $${index++}`);
    values.push(params.gender);
  }
  if (params.marriage) {
    where.push(`marriage = $${index++}`);
    values.push(params.marriage);
  }
  if (params.wealth) {
    where.push(`current_wealth = $${index++}`);
    values.push(params.wealth);
  }
  if (params.education) {
    where.push(`current_education = $${index++}`);
    values.push(params.education);
  }
  if (params.jobType) {
    where.push(`job_type = $${index++}`);
    values.push(params.jobType);
  }
  if (params.q) {
    // job 与 job_info 共用同一个关键词参数，子串不区分大小写匹配
    where.push(`(job ILIKE $${index} OR job_info ILIKE $${index})`);
    values.push(`%${params.q}%`);
    index += 1;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  values.push(params.limit, params.offset);

  const { rows } = await getDbPool().query(
    `SELECT ${BAZI_CASE_SELECT_COLUMNS},
            COUNT(*) OVER()::int AS __total
     FROM bazi_cases
     ${whereClause}
     ORDER BY id ASC
     LIMIT $${index} OFFSET $${index + 1}`,
    values,
  );

  const total =
    rows.length > 0 ? Number((rows[0] as { __total: number }).__total) : 0;

  return {
    rows: (rows as Array<BaziCaseRow & { __total: number }>).map(
      ({ __total: _total, ...row }) => row,
    ),
    total,
  };
}

/** 单维度取值分布项。 */
export interface BaziCaseDistributionRow {
  value: string;
  count: number;
}

/** 命例统计概览：各维度取值分布 + 总数。 */
export interface BaziCasesOverview {
  total: number;
  byGender: BaziCaseDistributionRow[];
  byMarriage: BaziCaseDistributionRow[];
  byJobType: BaziCaseDistributionRow[];
  byEducation: BaziCaseDistributionRow[];
  byInitWealth: BaziCaseDistributionRow[];
  byCurrentWealth: BaziCaseDistributionRow[];
}

/**
 * 按某一列做取值分布统计（计数降序）。
 *
 * @param column 列名。仅由本模块内部以硬编码白名单传入，绝不接受用户输入，故直接拼接无注入风险。
 */
async function distributionByColumn(
  column: string,
): Promise<BaziCaseDistributionRow[]> {
  const { rows } = await getDbPool().query(
    `SELECT COALESCE(${column}, '未知') AS value, COUNT(*)::int AS count
     FROM bazi_cases
     GROUP BY 1
     ORDER BY count DESC, value ASC`,
  );
  return rows as BaziCaseDistributionRow[];
}

/**
 * 汇总命例数据集的统计概览。各维度分布并行查询。
 */
export async function getBaziCasesOverview(): Promise<BaziCasesOverview> {
  const [
    total,
    byGender,
    byMarriage,
    byJobType,
    byEducation,
    byInitWealth,
    byCurrentWealth,
  ] = await Promise.all([
    getDbPool()
      .query<{ n: number }>('SELECT COUNT(*)::int AS n FROM bazi_cases')
      .then((r) => r.rows[0]?.n ?? 0),
    distributionByColumn('gender'),
    distributionByColumn('marriage'),
    distributionByColumn('job_type'),
    distributionByColumn('current_education'),
    distributionByColumn('init_wealth'),
    distributionByColumn('current_wealth'),
  ]);

  return {
    total,
    byGender,
    byMarriage,
    byJobType,
    byEducation,
    byInitWealth,
    byCurrentWealth,
  };
}

/** 命例行 + 反推阳历生日(算大运用)。 */
export interface BaziCaseFullRow extends BaziCaseRow {
  /** 反推阳历日期 YYYY-MM-DD;反推失败为 null。 */
  solar_date: string | null;
  /** 反推出生小时 0-23;反推失败为 null。 */
  solar_hour: number | null;
}

/**
 * 按 id 查单条命例(含反推阳历生日)。不存在返回 null。
 */
export async function getBaziCaseById(
  id: number,
): Promise<BaziCaseFullRow | null> {
  const { rows } = await getDbPool().query(
    `SELECT ${BAZI_CASE_SELECT_COLUMNS},
            to_char(solar_date, 'YYYY-MM-DD') AS solar_date,
            solar_hour
     FROM bazi_cases
     WHERE id = $1`,
    [id],
  );
  return (rows[0] as BaziCaseFullRow) ?? null;
}
