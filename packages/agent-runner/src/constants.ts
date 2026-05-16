/**
 * agent-runner 内部共享常量。
 */

/** 限制模型连续调用工具的最大轮数，防止死循环。 */
export const MAX_TOOL_ITERATIONS = 10;

/** Skill 脚本执行超时（毫秒）。 */
export const SKILL_SCRIPT_TIMEOUT = 30_000;

/** Skill 脚本输出最大长度（字符）。LLM 类 skill 可能输出较长文本。 */
export const SKILL_SCRIPT_MAX_OUTPUT = 30_000;

/** 上下文过长（400/413）时最多截断重试次数，防止截断不足导致无限循环。 */
export const MAX_TRUNCATION_RETRIES = 2;

/** Agent 循环全局超时（毫秒）。防止 API 或工具执行无限期挂起阻塞容器。 */
export const AGENT_LOOP_TIMEOUT = 180_000;

/**
 * Supervisor loop 超时（毫秒）。Supervisor 需多次委派 specialist（排盘 + 解读），
 * 每次委派可能耗时数分钟，因此超时需显著大于 delegate 工具超时。
 */
export const SUPERVISOR_LOOP_TIMEOUT = 600_000;

/**
 * 委派类工具超时（毫秒）。delegate_to_specialist 会执行完整 specialist loop，
 * interpret_xuanxue 会完成盘面校验和知识库规划，需大于 AGENT_LOOP_TIMEOUT
 * 但小于 SUPERVISOR_LOOP_TIMEOUT。
 */
export const DELEGATE_TOOL_TIMEOUT = 300_000;

/** 单个工具执行超时（毫秒）。Skill 脚本有独立的 SKILL_SCRIPT_TIMEOUT，此为兜底。 */
export const TOOL_EXECUTION_TIMEOUT = 60_000;

/** 工具并发执行上限。防止大量工具同时执行导致资源争抢。 */
export const MAX_CONCURRENT_TOOLS = 5;

/** SkillContext 最大条目数。超出后从头部（最旧）裁剪。 */
export const MAX_SKILL_CONTEXT_ENTRIES = 10;

/** 动作协议修复重试次数。模型若返回裸文本，最多提醒其改写为合法 step 这么多次。 */
export const MAX_PROTOCOL_REPAIR_RETRIES = 2;

/** 单次 read_knowledge_section 返回的 body 字节上限，超出截断。 */
export const XUANXUE_SECTION_MAX_BYTES = 8000;
