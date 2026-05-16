import { latestSkillArtifactExcluding } from '../../artifact-store.js';
import { normalizeCategoryName } from '../../category-normalize.js';
import { log } from '../../io.js';
import {
  isUserPastedBoardSkill,
  type UserPastedBoardArtifactData,
} from '../../pasted-board-context.js';
import type {
  getLatestFollowupInterpretation,
  RequestScope,
} from '../../request-scope.js';
import { traceEvent } from '../../trace.js';
import {
  resolveBoardSourceWithLLM,
  type BoardCandidate,
  type BoardResolutionResult,
  type BoardSource,
} from './board-resolver.js';
import { formatBoardForAi, hasBoardFormatter } from './board-formatters/index.js';
import type { LlmRuntimeSnapshot } from '../../types.js';

export type { BoardSource } from './board-resolver.js';

export interface UpstreamSkillRaw {
  /** 来源 skill 名，如 `iching-paipan`、`bazi-paipan`。 */
  skill: string;
  /** Skill 进程 stdout 原文。 */
  rawOutput: string;
  /** 解析后的结构化数据；若非 JSON 则退化为原文 string。 */
  payload: unknown;
}

/**
 * 起卦/排盘类官方 skill → 对应的术数类别关键字。
 * 用于 interpret_xuanxue 做"上游 artifact 与当前类别"一致性校验。
 */
const SKILL_CATEGORY_HINT: Record<string, string[]> = {
  'bazi-paipan': ['八字', '命理', '四柱'],
  'ziwei-paipan': ['紫微'],
  'iching-paipan': ['六爻', '纳甲', '火珠林', '摇卦'],
  'jingzhan-paipan': ['经占', '周易', '易经', '大衍', '略筮'],
  'qimen-paipan': ['奇门', '遁甲'],
};

type LatestFollowupInterpretation =
  ReturnType<typeof getLatestFollowupInterpretation>;

export interface BoardResolutionInput {
  rawArgContent: string;
  argContentSource: 'skill' | 'user';
  currentUserMessage: string;
  question?: string;
  contextHints: null;
  latestFollowupInterpretation: LatestFollowupInterpretation;
  currentRequestUpstreamSkillRaw: UpstreamSkillRaw | null;
  historicalUpstreamSkillRaw: UpstreamSkillRaw | null;
  historicalBoardContent: string | null;
  requestScope?: RequestScope;
  delegationGoal?: string;
  llmRuntime: LlmRuntimeSnapshot;
}

export interface ResolvedBoardPayload {
  boardSource: BoardSource;
  authoritativeContent: string;
  upstreamSkillRaw: UpstreamSkillRaw | null;
  modelPreparedContentNote: string | null;
  resolverReason: string;
  resolverConfidence: number;
  boardResolverUsed: boolean;
}

export function inferCategoryFromProducer(
  producer: string | undefined,
): string | undefined {
  if (!producer) return undefined;
  const hints = SKILL_CATEGORY_HINT[producer];
  return hints?.[0];
}

function parsePayloadSafe(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

export function buildUpstreamSkillRawFromContext(input: {
  skill: string;
  output: string;
  artifactData?: unknown;
}): UpstreamSkillRaw {
  return {
    skill: input.skill,
    rawOutput: input.output,
    payload: input.artifactData ?? parsePayloadSafe(input.output),
  };
}

function normalizeCategoryLabel(category: string): string {
  return normalizeCategoryName(category) ?? category;
}

function categoryLabelsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeCategoryLabel(left);
  const normalizedRight = normalizeCategoryLabel(right);
  return (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

export function boardSkillMatchesCategory(
  skillName: string | undefined,
  category: string | undefined,
): boolean {
  if (!skillName || !category) return true;
  const hints = SKILL_CATEGORY_HINT[skillName];
  if (!hints || hints.length === 0) return true;
  return hints.some((hint) => categoryLabelsMatch(hint, category));
}

function historicalContextMatchesCategory(
  previous: NonNullable<LatestFollowupInterpretation>,
  category: string | undefined,
): boolean {
  if (!category) return true;
  if (
    previous.boardSkill &&
    boardSkillMatchesCategory(previous.boardSkill, category)
  ) {
    return true;
  }
  return categoryLabelsMatch(previous.category, category);
}

export function resolveHistoricalUpstreamSkillRaw(
  previous: NonNullable<LatestFollowupInterpretation> | null,
  category: string | undefined,
): UpstreamSkillRaw | null {
  if (!previous?.boardSkill) return null;
  if (!historicalContextMatchesCategory(previous, category)) return null;

  const hasArtifactData = previous.boardArtifactData !== undefined;
  if (!previous.boardOutput && !hasArtifactData) return null;

  return {
    skill: previous.boardSkill,
    rawOutput:
      previous.boardOutput ??
      stringifyPayloadSafe(previous.boardArtifactData),
    payload: hasArtifactData
      ? previous.boardArtifactData
      : previous.boardOutput ?? '',
  };
}

export function resolveHistoricalBoardContent(
  previous: NonNullable<LatestFollowupInterpretation> | null,
  category: string | undefined,
): string | null {
  if (!previous?.boardOutput) return null;
  if (historicalContextMatchesCategory(previous, category)) {
    return previous.boardOutput;
  }
  return null;
}

export async function resolveAuthoritativeBoardPayload(
  input: BoardResolutionInput,
): Promise<ResolvedBoardPayload> {
  log(
    `interpret_xuanxue | 快速路径判断: argContentSource=${input.argContentSource} hasUpstreamArtifact=${Boolean(input.currentRequestUpstreamSkillRaw)}`,
  );

  const fastPathPayload = resolveCurrentRequestArtifactFastPath(input);
  if (fastPathPayload) return fastPathPayload;

  const candidates = buildBoardCandidates(input);
  const modelPreparedContentNote = buildBaseModelPreparedContentNote(
    candidates,
    input.rawArgContent,
  );

  if (candidates.length === 0) {
    return createModelContentFallbackPayload(
      input.rawArgContent,
      modelPreparedContentNote,
      'no_candidate_available',
      false,
    );
  }

  const singleCandidatePayload = resolveSingleCandidate(
    input,
    candidates,
    modelPreparedContentNote,
  );
  if (singleCandidatePayload) return singleCandidatePayload;

  const polishedContentPayload = resolvePolishedContentCandidate(
    input,
    candidates,
  );
  if (polishedContentPayload) return polishedContentPayload;

  const resolved = await resolveBoardSourceWithLLM({
    currentUserMessage: input.currentUserMessage,
    question: input.question,
    contextHints: input.contextHints,
    delegationGoalContext: input.delegationGoal,
    candidates,
    historicalInterpretationOutput:
      input.latestFollowupInterpretation?.interpretationOutput,
  }, input.llmRuntime);

  return resolveSelectedBoardSource(input, resolved, modelPreparedContentNote);
}

export function summarizeUpstreamArtifact(raw: UpstreamSkillRaw | null): {
  line: string;
  trace: Record<string, unknown>;
} {
  if (!raw) return { line: 'null', trace: {} };

  const parts: string[] = [`skill=${raw.skill}`];
  const trace: Record<string, unknown> = {
    upstreamRawBytes: raw.rawOutput.length,
  };
  const payload = raw.payload;

  let bytes: number | undefined;
  if (payload && typeof payload === 'object') {
    try {
      bytes = JSON.stringify(payload).length;
    } catch {
      bytes = undefined;
    }
  }

  if (Array.isArray(payload)) {
    parts.push(`payloadType=array(len=${payload.length} bytes=${bytes ?? '?'})`);
    trace.upstreamPayloadType = 'array';
    trace.upstreamPayloadBytes = bytes;
    trace.upstreamArrayLength = payload.length;
  } else if (payload && typeof payload === 'object') {
    const keys = Object.keys(payload as Record<string, unknown>).slice(0, 5);
    parts.push(
      `payloadType=object(keys=[${keys.join(',')}] bytes=${bytes ?? '?'})`,
    );
    trace.upstreamPayloadType = 'object';
    trace.upstreamPayloadBytes = bytes;
    trace.upstreamPayloadKeys = keys;
  } else if (typeof payload === 'string') {
    parts.push(`payloadType=string(len=${payload.length})`);
    trace.upstreamPayloadType = 'string';
    trace.upstreamPayloadBytes = payload.length;
  } else if (payload === null) {
    parts.push('payloadType=null');
    trace.upstreamPayloadType = 'null';
  } else {
    parts.push(`payloadType=${typeof payload}`);
    trace.upstreamPayloadType = typeof payload;
  }

  parts.push(`rawBytes=${raw.rawOutput.length}`);
  return { line: parts.join(' '), trace };
}

export function resolveUpstreamSkillRaw(opts: {
  contentSource: 'skill' | 'user';
  currentCategory: string | undefined;
  requestScope?: RequestScope;
}): UpstreamSkillRaw | null {
  if (opts.contentSource === 'user') {
    log('interpret_xuanxue | upstream 跳过: content_source=user');
    return null;
  }

  if (!opts.requestScope) {
    log('interpret_xuanxue | upstream 跳过: 缺少 requestScope');
    return null;
  }

  const artifact = latestSkillArtifactExcluding(
    opts.requestScope,
    ['xuanxue-jiedu'],
  );
  if (!artifact) {
    log('interpret_xuanxue | upstream 跳过: 本次请求无可用 skill artifact');
    return null;
  }

  const currentCategory = opts.currentCategory;
  const categoryMatches = boardSkillMatchesCategory(
    artifact.producer,
    currentCategory,
  );

  if (!categoryMatches) {
    const hints = SKILL_CATEGORY_HINT[artifact.producer];
    log(
      `interpret_xuanxue | upstream category 不匹配，跳过注入: artifactSkill=${artifact.producer} hints=${hints?.join('/')} currentCategory=${currentCategory}`,
    );
    traceEvent({
      type: 'xuanxue_upstream_rejected',
      reason: 'category_mismatch',
      artifactSkill: artifact.producer,
      artifactHints: hints,
      currentCategory,
    }, opts.requestScope);
    return null;
  }

  return {
    skill: artifact.producer,
    rawOutput: artifact.rawOutput,
    payload: artifact.payload,
  };
}

function resolveCurrentRequestArtifactFastPath(
  input: BoardResolutionInput,
): ResolvedBoardPayload | null {
  if (input.argContentSource !== 'skill' || !input.currentRequestUpstreamSkillRaw) {
    return null;
  }

  log(
    `interpret_xuanxue | 快速路径生效: 使用 artifact (${input.currentRequestUpstreamSkillRaw.skill})`,
  );
  return {
    boardSource: 'current_request_artifact',
    authoritativeContent: formatAuthoritativeContentFromUpstream(
      input.currentRequestUpstreamSkillRaw,
    ),
    upstreamSkillRaw: input.currentRequestUpstreamSkillRaw,
    modelPreparedContentNote: null,
    resolverReason: 'content_source_skill_with_artifact',
    resolverConfidence: 1,
    boardResolverUsed: false,
  };
}

function buildBoardCandidates(input: BoardResolutionInput): BoardCandidate[] {
  const candidates: BoardCandidate[] = [];

  if (input.currentRequestUpstreamSkillRaw) {
    candidates.push({
      source: 'current_request_artifact',
      content: formatAuthoritativeContentFromUpstream(
        input.currentRequestUpstreamSkillRaw,
      ),
      skillName: input.currentRequestUpstreamSkillRaw.skill,
    });
  }
  if (input.historicalUpstreamSkillRaw) {
    candidates.push({
      source: 'historical_artifact',
      content: formatAuthoritativeContentFromUpstream(
        input.historicalUpstreamSkillRaw,
      ),
      skillName: input.historicalUpstreamSkillRaw.skill,
    });
  }
  if (input.historicalBoardContent) {
    const isDuplicateHistoricalPastedBoard =
      input.historicalUpstreamSkillRaw &&
      isUserPastedBoardSkill(input.historicalUpstreamSkillRaw.skill) &&
      formatAuthoritativeContentFromUpstream(input.historicalUpstreamSkillRaw) ===
        input.historicalBoardContent;

    if (!isDuplicateHistoricalPastedBoard) {
      candidates.push({
        source: 'historical_board_output',
        content: input.historicalBoardContent,
        skillName: input.latestFollowupInterpretation?.boardSkill,
      });
    }
  }
  if (input.rawArgContent.trim()) {
    candidates.push({
      source: 'model_content',
      content: input.rawArgContent,
    });
  }

  return candidates;
}

function buildBaseModelPreparedContentNote(
  candidates: BoardCandidate[],
  rawArgContent: string,
): string | null {
  const firstBoardCandidate = candidates.find(
    (candidate) => candidate.source !== 'model_content',
  );
  return firstBoardCandidate
    ? buildModelPreparedContentNote(rawArgContent, firstBoardCandidate.content)
    : null;
}

function resolveSingleCandidate(
  input: BoardResolutionInput,
  candidates: BoardCandidate[],
  modelPreparedContentNote: string | null,
): ResolvedBoardPayload | null {
  const nonModelCandidates = candidates.filter(
    (candidate) => candidate.source !== 'model_content',
  );
  if (nonModelCandidates.length === 1 && !input.rawArgContent.trim()) {
    return resolveOnlyNonModelCandidate(
      input,
      nonModelCandidates[0],
      modelPreparedContentNote,
    );
  }

  if (candidates.length !== 1) return null;
  return createModelContentFallbackPayload(
    candidates[0].content,
    modelPreparedContentNote,
    'single_model_candidate',
    false,
    input.argContentSource === 'user' ? 'explicit_user_board' : undefined,
  );
}

function resolveOnlyNonModelCandidate(
  input: BoardResolutionInput,
  candidate: BoardCandidate,
  modelPreparedContentNote: string | null,
): ResolvedBoardPayload {
  const boardSource = mapCandidateSourceToBoardSource(candidate.source);
  const upstreamSkillRaw = resolveUpstreamForCandidate(input, candidate.source);
  return {
    boardSource,
    authoritativeContent: candidate.content,
    upstreamSkillRaw,
    modelPreparedContentNote: shouldKeepModelPreparedContentNote({
      boardSource,
      upstreamSkillRaw,
    })
      ? modelPreparedContentNote
      : null,
    resolverReason: 'single_non_model_candidate',
    resolverConfidence: 1,
    boardResolverUsed: false,
  };
}

function resolvePolishedContentCandidate(
  input: BoardResolutionInput,
  candidates: BoardCandidate[],
): ResolvedBoardPayload | null {
  const artifactCandidate = candidates.find(
    (candidate) =>
      candidate.source === 'current_request_artifact' ||
      candidate.source === 'historical_artifact',
  );
  if (
    !artifactCandidate ||
    input.argContentSource === 'user' ||
    !input.rawArgContent.trim() ||
    !isNonJsonContent(input.rawArgContent)
  ) {
    return null;
  }

  log(
    `interpret_xuanxue | 检测到润色文本，强制使用 artifact: artifactSkill=${artifactCandidate.skillName}`,
  );
  traceEvent({
    type: 'xuanxue_polished_content_detected',
    rawArgContentLength: input.rawArgContent.length,
    artifactSkill: artifactCandidate.skillName,
    artifactSource: artifactCandidate.source,
  }, input.requestScope);

  const boardSource = mapCandidateSourceToBoardSource(artifactCandidate.source);
  return {
    boardSource,
    authoritativeContent: artifactCandidate.content,
    upstreamSkillRaw: resolveUpstreamForCandidate(input, artifactCandidate.source),
    modelPreparedContentNote: null,
    resolverReason: 'polished_content_detected_force_artifact',
    resolverConfidence: 1,
    boardResolverUsed: false,
  };
}

function resolveSelectedBoardSource(
  input: BoardResolutionInput,
  resolved: BoardResolutionResult,
  modelPreparedContentNote: string | null,
): ResolvedBoardPayload {
  switch (resolved.selectedSource) {
    case 'current_request_artifact':
      return resolveCurrentArtifactSelection(input, resolved, modelPreparedContentNote);
    case 'active_board_context':
      throw new Error('board resolver 不应选择 active_board_context');
    case 'historical_artifact':
      return resolveHistoricalArtifactSelection(input, resolved, modelPreparedContentNote);
    case 'historical_board_output':
      return resolveHistoricalBoardOutputSelection(input, resolved, modelPreparedContentNote);
    case 'explicit_user_board':
    case 'model_content_fallback':
      return createModelContentFallbackPayload(
        input.rawArgContent,
        null,
        resolved.reason,
        true,
        resolved.selectedSource,
        resolved.confidence,
      );
  }
}

function resolveCurrentArtifactSelection(
  input: BoardResolutionInput,
  resolved: BoardResolutionResult,
  modelPreparedContentNote: string | null,
): ResolvedBoardPayload {
  if (!input.currentRequestUpstreamSkillRaw) {
    throw new Error('board resolver 选择了不存在的 current_request_artifact');
  }
  return createArtifactSelectionPayload(
    'current_request_artifact',
    input.currentRequestUpstreamSkillRaw,
    resolved,
    modelPreparedContentNote,
  );
}

function resolveHistoricalArtifactSelection(
  input: BoardResolutionInput,
  resolved: BoardResolutionResult,
  modelPreparedContentNote: string | null,
): ResolvedBoardPayload {
  if (!input.historicalUpstreamSkillRaw) {
    throw new Error('board resolver 选择了不存在的 historical_artifact');
  }
  return createArtifactSelectionPayload(
    'historical_artifact',
    input.historicalUpstreamSkillRaw,
    resolved,
    modelPreparedContentNote,
  );
}

function resolveHistoricalBoardOutputSelection(
  input: BoardResolutionInput,
  resolved: BoardResolutionResult,
  modelPreparedContentNote: string | null,
): ResolvedBoardPayload {
  if (!input.historicalBoardContent) {
    throw new Error('board resolver 选择了不存在的 historical_board_output');
  }
  return {
    boardSource: 'historical_board_output',
    authoritativeContent: input.historicalBoardContent,
    upstreamSkillRaw: null,
    modelPreparedContentNote,
    resolverReason: resolved.reason,
    resolverConfidence: resolved.confidence,
    boardResolverUsed: true,
  };
}

function createArtifactSelectionPayload(
  boardSource: 'current_request_artifact' | 'historical_artifact',
  upstreamSkillRaw: UpstreamSkillRaw,
  resolved: BoardResolutionResult,
  modelPreparedContentNote: string | null,
): ResolvedBoardPayload {
  return {
    boardSource,
    authoritativeContent: formatAuthoritativeContentFromUpstream(upstreamSkillRaw),
    upstreamSkillRaw,
    modelPreparedContentNote: shouldKeepModelPreparedContentNote({
      boardSource,
      upstreamSkillRaw,
    })
      ? modelPreparedContentNote
      : null,
    resolverReason: resolved.reason,
    resolverConfidence: resolved.confidence,
    boardResolverUsed: true,
  };
}

function createModelContentFallbackPayload(
  authoritativeContent: string,
  modelPreparedContentNote: string | null,
  reason: string,
  boardResolverUsed: boolean,
  boardSource: BoardSource = 'model_content_fallback',
  confidence = 1,
): ResolvedBoardPayload {
  return {
    boardSource,
    authoritativeContent,
    upstreamSkillRaw: null,
    modelPreparedContentNote,
    resolverReason: reason,
    resolverConfidence: confidence,
    boardResolverUsed,
  };
}

function mapCandidateSourceToBoardSource(
  source: BoardCandidate['source'],
): BoardSource {
  if (source === 'model_content') return 'model_content_fallback';
  return source;
}

function resolveUpstreamForCandidate(
  input: BoardResolutionInput,
  source: BoardCandidate['source'],
): UpstreamSkillRaw | null {
  if (source === 'current_request_artifact') {
    return input.currentRequestUpstreamSkillRaw;
  }
  if (source === 'historical_artifact') {
    return input.historicalUpstreamSkillRaw;
  }
  return null;
}

function formatAuthoritativeContentFromUpstream(raw: UpstreamSkillRaw): string {
  if (
    isUserPastedBoardSkill(raw.skill) &&
    raw.payload &&
    typeof raw.payload === 'object' &&
    typeof (raw.payload as UserPastedBoardArtifactData).content === 'string'
  ) {
    return (raw.payload as UserPastedBoardArtifactData).content;
  }
  if (raw.payload && typeof raw.payload === 'object') {
    if (hasBoardFormatter(raw.skill)) {
      return formatBoardForAi({
        skill: raw.skill,
        output: raw.rawOutput,
        artifactData: raw.payload,
      });
    }
    return stringifyPayloadSafe(raw.payload);
  }
  return raw.rawOutput;
}

function buildModelPreparedContentNote(
  modelPreparedContent: string,
  authoritativeContent: string,
): string | null {
  const normalizedModel = modelPreparedContent.trim();
  if (!normalizedModel) return null;
  const normalizedAuthoritative = authoritativeContent.trim();
  if (normalizedModel === normalizedAuthoritative) return null;
  if (
    normalizedModel.length > 20 &&
    normalizedAuthoritative.includes(normalizedModel)
  ) {
    return null;
  }
  return [
    '【主对话整理稿】',
    '以下内容来自主对话模型的整理，仅用于理解用户关切点，不作为盘面事实依据。',
    normalizedModel,
  ].join('\n');
}

function shouldKeepModelPreparedContentNote(args: {
  boardSource: BoardSource;
  upstreamSkillRaw: UpstreamSkillRaw | null;
}): boolean {
  if (!args.upstreamSkillRaw) return true;
  return !(
    args.boardSource === 'current_request_artifact' ||
    args.boardSource === 'historical_artifact'
  );
}

function stringifyPayloadSafe(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function isNonJsonContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}
