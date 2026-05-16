const LEDGER_SCHEMA_VERSION = 1;

type RequirementStatus =
  | 'registered'
  | 'satisfied_read'
  | 'satisfied_skip'
  | 'denied';

interface LedgerTarget {
  skillDir: string;
  skillName: string;
  readSections: string[];
}

interface LedgerRequirement {
  requirementId: string;
  capability: string;
  status: RequirementStatus;
  targets: LedgerTarget[];
  skipReason?: string;
  warnings: string[];
}

interface LedgerRun {
  contractVersion: number;
  runId: string;
  attemptId: string;
  provider?: string;
  model?: string;
  enforcementDisabled: boolean;
  requirements: LedgerRequirement[];
  events: {
    registered: number;
    read: number;
    skip: number;
    rejected: number;
    denied: number;
  };
}

export interface ConversationCapabilityLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  runs: LedgerRun[];
}

interface MutableLedgerRun {
  contractVersion: number;
  runId: string;
  attemptId: string;
  provider?: string;
  model?: string;
  enforcementDisabled: boolean;
  requirements: Map<string, LedgerRequirement>;
  rejected: number;
}

export function buildConversationCapabilityLedger(
  traceEvents: unknown[],
): ConversationCapabilityLedger | null {
  const runs = new Map<string, MutableLedgerRun>();

  for (const event of traceEvents) {
    if (!isRecord(event) || !isContractEvent(event)) continue;
    const run = getOrCreateRun(runs, event);
    if (event.type === 'contract_requirement_registered') {
      applyRequirementRegistered(run, event);
    } else if (event.type === 'contract_action_recorded') {
      applyActionRecorded(run, event);
    } else if (event.type === 'contract_finalization_checked') {
      applyFinalizationChecked(run, event);
    } else if (event.type === 'contract_enforcement_disabled') {
      run.enforcementDisabled = true;
    }
  }

  const materialized = Array.from(runs.values()).map(materializeRun);
  return materialized.length > 0
    ? { schemaVersion: LEDGER_SCHEMA_VERSION, runs: materialized }
    : null;
}

function getOrCreateRun(
  runs: Map<string, MutableLedgerRun>,
  event: Record<string, unknown>,
): MutableLedgerRun {
  const runId = readString(event.runId) || 'unknown-run';
  const existing = runs.get(runId);
  if (existing) return existing;
  const next: MutableLedgerRun = {
    contractVersion: readNumber(event.contractVersion) ?? 1,
    runId,
    attemptId: readString(event.attemptId) || 'unknown-attempt',
    provider: readOptionalString(event.provider),
    model: readOptionalString(event.model),
    enforcementDisabled: false,
    requirements: new Map(),
    rejected: 0,
  };
  runs.set(runId, next);
  return next;
}

function applyRequirementRegistered(
  run: MutableLedgerRun,
  event: Record<string, unknown>,
): void {
  const requirementId = readString(event.requirementId);
  if (!requirementId) return;
  const payload = readRecord(event.payload);
  run.requirements.set(requirementId, {
    requirementId,
    capability: readString(payload.capability) || 'unknown',
    status: 'registered',
    targets: readTargets(payload.targets),
    warnings: [],
  });
}

function applyActionRecorded(
  run: MutableLedgerRun,
  event: Record<string, unknown>,
): void {
  const payload = readRecord(event.payload);
  const requirementId = readString(event.requirementId);
  if (!requirementId) return;
  const requirement = ensureRequirement(run, requirementId);
  const action = readString(payload.action);
  const status = readString(payload.status);
  const reason = readString(payload.reason);

  if (status === 'rejected') run.rejected += 1;
  if (status !== 'success') {
    if (reason) requirement.warnings.push(reason);
    return;
  }

  if (action === 'read') {
    requirement.status = 'satisfied_read';
    mergeReadTarget(requirement, readRecord(payload.target));
  } else if (action === 'skip' && requirement.status !== 'satisfied_read') {
    requirement.status = 'satisfied_skip';
    requirement.skipReason = reason || undefined;
  }
}

function applyFinalizationChecked(
  run: MutableLedgerRun,
  event: Record<string, unknown>,
): void {
  const payload = readRecord(event.payload);
  if (payload.enforcementDisabled === true) run.enforcementDisabled = true;
  if (payload.allowed === true) return;
  for (const requirementId of readStringArray(payload.deniedRequirementIds)) {
    const requirement = ensureRequirement(run, requirementId);
    if (
      requirement.status !== 'satisfied_read' &&
      requirement.status !== 'satisfied_skip'
    ) {
      requirement.status = 'denied';
    }
  }
}

function materializeRun(run: MutableLedgerRun): LedgerRun {
  const requirements = Array.from(run.requirements.values()).map(
    (requirement) => ({
      ...requirement,
      targets: requirement.targets.map((target) => ({
        ...target,
        readSections: dedupe(target.readSections),
      })),
      warnings: dedupe(requirement.warnings),
    }),
  );
  return {
    contractVersion: run.contractVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    provider: run.provider,
    model: run.model,
    enforcementDisabled: run.enforcementDisabled,
    requirements,
    events: {
      registered: requirements.length,
      read: requirements.filter((item) => item.status === 'satisfied_read')
        .length,
      skip: requirements.filter((item) => item.status === 'satisfied_skip')
        .length,
      rejected: run.rejected,
      denied: requirements.filter((item) => item.status === 'denied').length,
    },
  };
}

function ensureRequirement(
  run: MutableLedgerRun,
  requirementId: string,
): LedgerRequirement {
  const existing = run.requirements.get(requirementId);
  if (existing) return existing;
  const created: LedgerRequirement = {
    requirementId,
    capability: 'unknown',
    status: 'registered',
    targets: [],
    warnings: [],
  };
  run.requirements.set(requirementId, created);
  return created;
}

function mergeReadTarget(
  requirement: LedgerRequirement,
  target: Record<string, unknown>,
): void {
  const skillDir = readString(target.skillDir);
  const sectionTitle = readString(target.sectionTitle);
  if (!skillDir || !sectionTitle) return;
  let existing = requirement.targets.find((item) => item.skillDir === skillDir);
  if (!existing) {
    existing = {
      skillDir,
      skillName: readString(target.skillName),
      readSections: [],
    };
    requirement.targets.push(existing);
  }
  existing.readSections.push(sectionTitle);
}

function readTargets(value: unknown): LedgerTarget[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((target) => ({
      skillDir: readString(target.skillDir),
      skillName: readString(target.skillName),
      readSections: [],
    }))
    .filter((target) => target.skillDir);
}

function isContractEvent(event: Record<string, unknown>): boolean {
  return typeof event.type === 'string' && event.type.startsWith('contract_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text || undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
