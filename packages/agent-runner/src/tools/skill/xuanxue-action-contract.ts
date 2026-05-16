import {
  buildCapabilityLedger,
  checkFinalization,
  createActionContractRun,
  markRepairRequested,
  recordAction,
  registerRequirement,
  type ActionContractRun,
  type CapabilityLedger,
  type ContractFinalizationDecision,
  type FinalizationMode,
} from '../../loop/action-contract.js';
import type { RequestScope } from '../../request-scope.js';
import type { ToolResult } from '../../types.js';
import { createToolErrorResult } from './tool-error.js';
import type { KnowledgeSkillBundle } from './xuanxue-knowledge.js';

export const XUANXUE_QUERYABLE_KNOWLEDGE_REQUIREMENT_ID =
  'xuanxue.queryable_knowledge';

export class XuanxueContractFinalizationError extends Error {
  readonly decision: ContractFinalizationDecision;
  readonly ledger: CapabilityLedger | null;

  constructor(
    message: string,
    decision: ContractFinalizationDecision,
    ledger: CapabilityLedger | null,
  ) {
    super(message);
    this.name = 'XuanxueContractFinalizationError';
    this.decision = decision;
    this.ledger = ledger;
  }
}

export interface XuanxueActionContractRun {
  readonly run: ActionContractRun;
  readonly queryable: KnowledgeSkillBundle[];
}

export function createXuanxueActionContract(args: {
  queryable: KnowledgeSkillBundle[];
  question?: string;
  category?: string;
  provider?: string;
  model?: string;
  requestScope?: RequestScope;
}): XuanxueActionContractRun | undefined {
  if (args.queryable.length === 0) return undefined;
  const run = createActionContractRun({
    provider: args.provider,
    model: args.model,
    requestScope: args.requestScope,
    enforcementDisabled: isXuanxueContractEnforcementDisabled(),
  });
  registerRequirement(run, {
    id: XUANXUE_QUERYABLE_KNOWLEDGE_REQUIREMENT_ID,
    capability: 'knowledge',
    reason: 'xuanxue interpretation has queryable user knowledge',
    requiredWhen: 'queryable.length > 0',
    allowSkip: true,
    targets: args.queryable.map((bundle) => ({
      skillDir: bundle.skill_dir,
      skillName: bundle.skill_name,
      sectionTitles: bundle.sections.map((section) => section.title),
    })),
  });
  return { run, queryable: args.queryable };
}

export function recordXuanxueKnowledgeToolResult(args: {
  contract?: XuanxueActionContractRun;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: { output: string; isError?: boolean };
}): void {
  const { contract } = args;
  if (!contract || args.toolName !== 'read_knowledge_section') return;

  const skillDir = readString(args.toolArgs.skill_dir);
  const sectionTitle = readString(args.toolArgs.section_title);
  const bundle = contract.queryable.find((item) => item.skill_dir === skillDir);
  const target = {
    skillDir,
    skillName: bundle?.skill_name,
    sectionTitle,
  };

  if (args.result.isError) {
    recordAction(contract.run, {
      requirementId: XUANXUE_QUERYABLE_KNOWLEDGE_REQUIREMENT_ID,
      action: 'read',
      status: 'failed',
      toolName: args.toolName,
      target,
      reason: 'read_knowledge_section returned error',
      details: { output: args.result.output.slice(0, 300) },
    });
    return;
  }

  const parsed = parseObject(args.result.output);
  const body = readString(parsed.body);
  const truncated = parsed.truncated === true;
  const valid =
    Boolean(bundle) &&
    Boolean(sectionTitle) &&
    sectionExists(bundle, sectionTitle) &&
    body.trim().length > 0 &&
    !truncated;

  recordAction(contract.run, {
    requirementId: XUANXUE_QUERYABLE_KNOWLEDGE_REQUIREMENT_ID,
    action: 'read',
    status: valid ? 'success' : 'failed',
    toolName: args.toolName,
    target,
    reason: valid
      ? 'read_knowledge_section succeeded'
      : 'read_knowledge_section did not return authorized non-empty untruncated content',
    details: {
      bodyBytes: body ? Buffer.byteLength(body, 'utf8') : 0,
      truncated,
      knownSkill: Boolean(bundle),
      knownSection: Boolean(bundle && sectionExists(bundle, sectionTitle)),
    },
  });
}

export function recordXuanxueKnowledgeSkip(args: {
  contract?: XuanxueActionContractRun;
  toolArgs: Record<string, unknown>;
}): ToolResult {
  const reason = readString(args.toolArgs.reason).trim();
  const consideredSkillDirs = readStringArray(args.toolArgs.considered_skill_dirs);
  const userTopic = readString(args.toolArgs.user_topic).trim();
  const availableTopic = readString(args.toolArgs.available_topic).trim();
  const whyNotApplicable = readString(args.toolArgs.why_not_applicable).trim();
  const invalidReasons = validateSkip({
    reason,
    consideredSkillDirs,
    userTopic,
    availableTopic,
    whyNotApplicable,
    queryable: args.contract?.queryable ?? [],
  });

  if (!args.contract) {
    return {
      output: JSON.stringify({ skipped: true, reason }),
      passthroughSafe: true,
    };
  }

  const valid = invalidReasons.length === 0;
  recordAction(args.contract.run, {
    requirementId: XUANXUE_QUERYABLE_KNOWLEDGE_REQUIREMENT_ID,
    action: 'skip',
    status: valid ? 'success' : 'rejected',
    toolName: 'skip_knowledge_lookup',
    reason,
    details: {
      consideredSkillDirs,
      userTopic,
      availableTopic,
      whyNotApplicable,
      invalidReasons,
    },
  });

  if (!valid) {
    return {
      output: [
        'skip_knowledge_lookup 协议错误：跳过知识读取必须给出具体结构化理由。',
        `问题：${invalidReasons.join('；')}`,
        '请改为读取相关章节，或重新调用 skip_knowledge_lookup 并提供 reason、considered_skill_dirs、user_topic、available_topic、why_not_applicable。',
      ].join('\n'),
      isError: true,
      passthroughSafe: true,
    };
  }

  return {
    output: JSON.stringify({
      skipped: true,
      reason,
      considered_skill_dirs: consideredSkillDirs,
      user_topic: userTopic,
      available_topic: availableTopic,
      why_not_applicable: whyNotApplicable,
    }),
    passthroughSafe: true,
  };
}

export function ensureXuanxueFinalizationAllowed(args: {
  contract?: XuanxueActionContractRun;
  mode: FinalizationMode;
  allowRepair?: boolean;
}): ContractFinalizationDecision {
  const decision = checkFinalization(args.contract?.run, args.mode);
  if (decision.allowed) return decision;

  if (args.allowRepair !== false && decision.repairable && args.contract) {
    markRepairRequested(args.contract.run, decision);
    return decision;
  }

  throw new XuanxueContractFinalizationError(
    buildXuanxueContractDeniedInternalMessage(decision),
    decision,
    buildCapabilityLedger(args.contract?.run),
  );
}

export function buildXuanxueContractRepairInstruction(
  contract: XuanxueActionContractRun,
  decision: ContractFinalizationDecision,
): string {
  const queryableSummary = contract.queryable
    .map((bundle) => {
      const titles = bundle.sections.map((section) => section.title).slice(0, 6);
      return `- ${bundle.skill_name} (${bundle.skill_dir}): ${titles.join('、') || '无章节'}`;
    })
    .join('\n');
  return [
    '协议错误：本轮存在可查用户知识库，你不能直接给最终解读。',
    '你必须先完成以下动作之一：',
    '1. 调用 read_knowledge_section 读取一个直接相关章节。',
    '2. 如果确实没有相关章节，调用 skip_knowledge_lookup，并提供具体结构化理由。',
    `未满足的 requirement: ${decision.deniedRequirementIds.join(', ')}`,
    '可查知识库：',
    queryableSummary || '(无)',
  ].join('\n');
}

export function createXuanxueContractToolErrorResult(
  err: XuanxueContractFinalizationError,
): ToolResult {
  return createToolErrorResult({
    code: 'SYSTEM.PROTOCOL',
    kind: 'internal',
    retryable: true,
    userSafe: true,
    nextAction: 'retry',
    userMessage: '本次解读需要读取创作者知识，但系统没有完成必要步骤。请重试。',
    internalMessage: err.message,
    details: {
      deniedRequirementIds: err.decision.deniedRequirementIds,
      mode: err.decision.mode,
      ledger: err.ledger,
    },
  });
}

export function buildXuanxueKnowledgeProvenanceLabel(
  contract: XuanxueActionContractRun | undefined,
): string | null {
  const ledger = buildCapabilityLedger(contract?.run);
  const requirement = ledger?.requirements.find(
    (item) => item.requirementId === XUANXUE_QUERYABLE_KNOWLEDGE_REQUIREMENT_ID,
  );
  if (!requirement || requirement.status !== 'satisfied_read') return null;
  const skillNames = requirement.targets
    .filter((target) => target.readSections.length > 0)
    .map((target) => target.skillName)
    .filter(Boolean);
  if (skillNames.length === 0) return null;
  return `参考：${Array.from(new Set(skillNames)).join('、')}`;
}

export function buildXuanxueCapabilityLedger(
  contract: XuanxueActionContractRun | undefined,
): CapabilityLedger | null {
  return buildCapabilityLedger(contract?.run);
}

function validateSkip(args: {
  reason: string;
  consideredSkillDirs: string[];
  userTopic: string;
  availableTopic: string;
  whyNotApplicable: string;
  queryable: KnowledgeSkillBundle[];
}): string[] {
  const invalid: string[] = [];
  if (!args.reason || isGenericSkipReason(args.reason)) {
    invalid.push('reason 不能是泛泛的 not needed / irrelevant');
  }
  if (args.consideredSkillDirs.length === 0) {
    invalid.push('considered_skill_dirs 不能为空');
  }
  const availableDirs = new Set(args.queryable.map((bundle) => bundle.skill_dir));
  if (args.consideredSkillDirs.some((dir) => !availableDirs.has(dir))) {
    invalid.push('considered_skill_dirs 包含不存在的 skill_dir');
  }
  if (!args.userTopic) invalid.push('user_topic 不能为空');
  if (!args.availableTopic) invalid.push('available_topic 不能为空');
  if (!args.whyNotApplicable || isGenericSkipReason(args.whyNotApplicable)) {
    invalid.push('why_not_applicable 必须说明具体不匹配点');
  }
  return invalid;
}

function isGenericSkipReason(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return [
    'not needed',
    'irrelevant',
    'no need',
    'not relevant',
    '无需',
    '不需要',
    '不相关',
    '没有必要',
  ].some((item) => normalized === item || normalized.includes(item));
}

function buildXuanxueContractDeniedInternalMessage(
  decision: ContractFinalizationDecision,
): string {
  return [
    '玄学子流程违反 action contract：存在可查用户知识库，但最终回答前没有成功读取章节或给出有效跳过理由。',
    `mode=${decision.mode}`,
    `missing=${decision.deniedRequirementIds.join(', ')}`,
  ].join(' ');
}

function isXuanxueContractEnforcementDisabled(): boolean {
  return process.env.XUANXUE_ACTION_CONTRACT_ENFORCEMENT === 'off';
}

function sectionExists(
  bundle: KnowledgeSkillBundle | undefined,
  title: string,
): boolean {
  return Boolean(bundle?.sections.some((section) => section.title === title));
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
