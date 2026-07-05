/**
 * 八字命例数据集契约。
 *
 * 一份「八字 → 真实人生结果」的标注语料：每条记录是一个四柱命盘 + 其已发生的真实人生轨迹
 * （出身/学历/婚姻/子女/财富起止/职业经历）。用于公开命例展览页与对外开放的只读查询 API。
 */

/** 单条八字命例。 */
export interface BaziCaseDto {
  id: number;
  /** 四柱八字，空格分隔，如 "甲子 己巳 壬寅 甲辰"。 */
  bazi: string;
  /** 性别：男 / 女。 */
  gender: string;
  /** 婚姻状况：一婚 / 一婚离异 / 未婚 / 二婚 ... 缺失为 null。 */
  marriage: string | null;
  /** 子女描述，原样字符串（源数据有不规整写法，不拆计数），如 "0男2女"。 */
  children_desc: string | null;
  /** 堕胎数；源数据缺失（-1）时为 null。 */
  abortions_size: number | null;
  /** 子女夭折数；源数据缺失（-1）时为 null。 */
  child_deaths_size: number | null;
  /** 学历层级：低学历 / 专科 / 本科 / 顶级学历 ... */
  current_education: string | null;
  /** 父母状况：父母健在 / 母在父亡 / 父母离异 ... */
  current_parent: string | null;
  /** 出身（初始）财富层级：贫困 / 温饱 / 小康 / 官宦 ... */
  init_wealth: string | null;
  /** 当前财富层级（与 init_wealth 对照可见一生财富起落）。 */
  current_wealth: string | null;
  /** 职业（简述），如 "副区长"。 */
  job: string | null;
  /** 职业类型：自由打工 / 稳定工作。 */
  job_type: string | null;
  /** 人生轨迹详述（带时间线的自然语言）。 */
  job_info: string | null;
}

/** 命例列表响应（含分页元信息）。 */
export interface BaziCaseListResponseDto {
  entries: BaziCaseDto[];
  /** 当前筛选条件下的命中总数（用于分页）。 */
  total: number;
  limit: number;
  offset: number;
}

/** 单个维度的取值分布项。 */
export interface BaziCaseDistributionItemDto {
  value: string;
  count: number;
}

/** 命例数据集统计概览（各维度分布，按计数降序）。 */
export interface BaziCaseOverviewDto {
  /** 数据集总条数。 */
  total: number;
  by_gender: BaziCaseDistributionItemDto[];
  by_marriage: BaziCaseDistributionItemDto[];
  by_job_type: BaziCaseDistributionItemDto[];
  by_education: BaziCaseDistributionItemDto[];
  /** 财富层级：出身分布。 */
  by_init_wealth: BaziCaseDistributionItemDto[];
  /** 财富层级：当前分布（与 by_init_wealth 对照看「起点 → 终点」流向）。 */
  by_current_wealth: BaziCaseDistributionItemDto[];
}

/** 单步大运。 */
export interface BaziDecadeDto {
  /** 大运干支，如 "庚午"。 */
  ganzhi: string;
  /** 起始虚岁。 */
  startAge: number;
  /** 结束虚岁。 */
  endAge: number;
}

/**
 * 大运信息。基于「反推阳历生日」计算（命例无真实生日）。
 *
 * @remarks 起运岁数、干支序列、年龄区间确定可信；但因反推年份不一定是真实出生年，
 *          故不提供公历年份，只给虚岁区间。
 */
export interface BaziFortuneDto {
  /** 起运虚岁。 */
  startAge: number;
  /** 顺排（true）/ 逆排（false）。 */
  isForward: boolean;
  decades: BaziDecadeDto[];
}

/** 命例详情：命例字段 + 大运（无反推生日时 fortune 为 null）。 */
export interface BaziCaseDetailDto extends BaziCaseDto {
  fortune: BaziFortuneDto | null;
}
