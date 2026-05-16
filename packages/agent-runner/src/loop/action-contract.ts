import { traceEvent } from '../trace.js';
import type { RequestScope } from '../request-scope.js';

export const ACTION_CONTRACT_VERSION = 1;

export type CapabilityKind = 'knowledge';
export type RequirementStatus =
  | 'registered'
  | 'satisfied_read'
  | 'satisfied_skip'
  | 'denied';
export type ContractActionKind = 'read' | 'skip' | 'fail' | 'cancel';
export type ContractActionStatus = 'success' | 'failed' | 'rejected';
export type FinalizationMode =
  | 'final'
  | 'partial'
  | 'cancelled'
  | 'error';

export interface ContractRequirement {
  id: string;
  capability: CapabilityKind;
  reason: string;
  requiredWhen: string;
  allowSkip: boolean;
  targets: ContractTarget[];
}

export interface ContractTarget {
  skillDir: string;
  skillName: string;
  sectionTitles: string[];
}

export interface ContractAction {
  requirementId: string;
  action: ContractActionKind;
  status: ContractActionStatus;
  toolName: string;
  target?: {
    skillDir?: string;
    skillName?: string;
    sectionTitle?: string;
  };
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ContractEvent extends Record<string, unknown> {
  contractVersion: typeof ACTION_CONTRACT_VERSION;
  runId: string;
  attemptId: string;
  eventId: string;
  type:
    | 'contract_requirement_registered'
    | 'contract_action_recorded'
    | 'contract_finalization_checked'
    | 'contract_repair_requested'
    | 'contract_enforcement_disabled';
  requirementId?: string;
  provider?: string;
  model?: string;
  payload?: Record<string, unknown>;
}

type ContractEventInput = {
  type: ContractEvent['type'];
  requirementId?: string;
  payload?: Record<string, unknown>;
};

export interface ContractFinalizationDecision {
  allowed: boolean;
  deniedRequirementIds: string[];
  mode: FinalizationMode;
  repairable: boolean;
  enforcementDisabled: boolean;
  reason?: string;
}

export interface CapabilityLedgerRequirement {
  requirementId: string;
  capability: CapabilityKind;
  status: RequirementStatus;
  targets: Array<{
    skillDir: string;
    skillName: string;
    readSections: string[];
  }>;
  skipReason?: string;
  warnings: string[];
}

export interface CapabilityLedger {
  contractVersion: typeof ACTION_CONTRACT_VERSION;
  runId: string;
  attemptId: string;
  provider?: string;
  model?: string;
  enforcementDisabled: boolean;
  requirements: CapabilityLedgerRequirement[];
  events: {
    registered: number;
    read: number;
    skip: number;
    rejected: number;
    denied: number;
  };
}

export interface ActionContractRun {
  readonly contractVersion: typeof ACTION_CONTRACT_VERSION;
  readonly runId: string;
  readonly attemptId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly requestScope?: RequestScope;
  readonly enforcementDisabled: boolean;
  readonly requirements: Map<string, ContractRequirement>;
  readonly actions: ContractAction[];
  repairAttempts: number;
  eventSeq: number;
}

export function createActionContractRun(options: {
  runId?: string;
  attemptId?: string;
  provider?: string;
  model?: string;
  requestScope?: RequestScope;
  enforcementDisabled?: boolean;
}): ActionContractRun {
  return {
    contractVersion: ACTION_CONTRACT_VERSION,
    runId: options.runId ?? createId('contract-run'),
    attemptId: options.attemptId ?? createId('attempt'),
    provider: options.provider,
    model: options.model,
    requestScope: options.requestScope,
    enforcementDisabled: options.enforcementDisabled === true,
    requirements: new Map(),
    actions: [],
    repairAttempts: 0,
    eventSeq: 0,
  };
}

export function registerRequirement(
  run: ActionContractRun,
  requirement: ContractRequirement,
): void {
  run.requirements.set(requirement.id, requirement);
  emitContractEvent(run, {
    type: 'contract_requirement_registered',
    requirementId: requirement.id,
    payload: {
      capability: requirement.capability,
      reason: requirement.reason,
      requiredWhen: requirement.requiredWhen,
      allowSkip: requirement.allowSkip,
      targets: requirement.targets.map((target) => ({
        skillDir: target.skillDir,
        skillName: target.skillName,
        sectionCount: target.sectionTitles.length,
      })),
    },
  });
}

export function recordAction(
  run: ActionContractRun | undefined,
  action: ContractAction,
): void {
  if (!run) return;
  run.actions.push(action);
  emitContractEvent(run, {
    type: 'contract_action_recorded',
    requirementId: action.requirementId,
    payload: {
      action: action.action,
      status: action.status,
      toolName: action.toolName,
      target: action.target,
      reason: action.reason,
      details: action.details,
    },
  });
}

export function checkFinalization(
  run: ActionContractRun | undefined,
  mode: FinalizationMode,
): ContractFinalizationDecision {
  if (!run || run.requirements.size === 0) {
    return {
      allowed: true,
      deniedRequirementIds: [],
      mode,
      repairable: false,
      enforcementDisabled: false,
    };
  }

  const deniedRequirementIds = Array.from(run.requirements.values())
    .filter((requirement) => !isRequirementSatisfied(run, requirement))
    .map((requirement) => requirement.id);
  const allowed = deniedRequirementIds.length === 0 || run.enforcementDisabled;
  const decision: ContractFinalizationDecision = {
    allowed,
    deniedRequirementIds,
    mode,
    repairable: deniedRequirementIds.length > 0 && run.repairAttempts < 1,
    enforcementDisabled: run.enforcementDisabled,
    reason: deniedRequirementIds.length > 0
      ? `Unsatisfied requirements: ${deniedRequirementIds.join(', ')}`
      : undefined,
  };
  emitContractEvent(run, {
    type: 'contract_finalization_checked',
    payload: {
      mode,
      allowed,
      deniedRequirementIds,
      repairable: decision.repairable,
      enforcementDisabled: run.enforcementDisabled,
    },
  });
  if (run.enforcementDisabled && deniedRequirementIds.length > 0) {
    emitContractEvent(run, {
      type: 'contract_enforcement_disabled',
      payload: { mode, deniedRequirementIds },
    });
  }
  return decision;
}

export function markRepairRequested(
  run: ActionContractRun,
  decision: ContractFinalizationDecision,
): void {
  run.repairAttempts += 1;
  emitContractEvent(run, {
    type: 'contract_repair_requested',
    payload: {
      mode: decision.mode,
      deniedRequirementIds: decision.deniedRequirementIds,
      repairAttempt: run.repairAttempts,
    },
  });
}

export function buildCapabilityLedger(
  run: ActionContractRun | undefined,
): CapabilityLedger | null {
  if (!run || run.requirements.size === 0) return null;
  const requirements = Array.from(run.requirements.values()).map((requirement) =>
    buildRequirementLedger(run, requirement)
  );
  return {
    contractVersion: ACTION_CONTRACT_VERSION,
    runId: run.runId,
    attemptId: run.attemptId,
    provider: run.provider,
    model: run.model,
    enforcementDisabled: run.enforcementDisabled,
    requirements,
    events: {
      registered: run.requirements.size,
      read: run.actions.filter((action) =>
        action.action === 'read' && action.status === 'success'
      ).length,
      skip: run.actions.filter((action) =>
        action.action === 'skip' && action.status === 'success'
      ).length,
      rejected: run.actions.filter((action) => action.status === 'rejected').length,
      denied: requirements.filter((item) => item.status === 'denied').length,
    },
  };
}

function buildRequirementLedger(
  run: ActionContractRun,
  requirement: ContractRequirement,
): CapabilityLedgerRequirement {
  const requirementActions = run.actions.filter(
    (action) => action.requirementId === requirement.id,
  );
  const readActions = requirementActions.filter((action) =>
    action.action === 'read' && action.status === 'success'
  );
  const skipAction = requirementActions.find((action) =>
    action.action === 'skip' && action.status === 'success'
  );
  const status: RequirementStatus = readActions.length > 0
    ? 'satisfied_read'
    : skipAction
      ? 'satisfied_skip'
      : 'denied';
  return {
    requirementId: requirement.id,
    capability: requirement.capability,
    status,
    targets: requirement.targets.map((target) => ({
      skillDir: target.skillDir,
      skillName: target.skillName,
      readSections: dedupe(
        readActions
          .filter((action) => action.target?.skillDir === target.skillDir)
          .map((action) => action.target?.sectionTitle)
          .filter((title): title is string => Boolean(title)),
      ),
    })),
    skipReason: skipAction?.reason,
    warnings: requirementActions
      .filter((action) => action.status !== 'success')
      .map((action) => String(action.reason || action.details?.error || action.status)),
  };
}

function isRequirementSatisfied(
  run: ActionContractRun,
  requirement: ContractRequirement,
): boolean {
  return run.actions.some((action) => {
    if (action.requirementId !== requirement.id) return false;
    if (action.status !== 'success') return false;
    if (action.action === 'read') return true;
    return action.action === 'skip' && requirement.allowSkip;
  });
}

function emitContractEvent(
  run: ActionContractRun,
  event: ContractEventInput,
): void {
  run.eventSeq += 1;
  const fullEvent: ContractEvent = {
    contractVersion: ACTION_CONTRACT_VERSION,
    runId: run.runId,
    attemptId: run.attemptId,
    eventId: `${run.runId}:${run.eventSeq}`,
    provider: run.provider,
    model: run.model,
    ...event,
  };
  traceEvent(fullEvent, run.requestScope);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
