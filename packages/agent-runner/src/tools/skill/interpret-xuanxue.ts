/**
 * interpret_xuanxue Pi custom tool handler。
 *
 * 负责校验盘面、规划用户知识库，并把解读材料交回主 loop。
 */

import { latestSkillArtifactExcluding } from '../../artifact-store.js';
import { normalizeCategoryName } from '../../category-normalize.js';
import { getContext } from '../../context.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import type { AgentRuntimeDeps } from '../../deps.js';
import { log } from '../../io.js';
import {
  getLatestFollowupInterpretation,
  getRequestId,
} from '../../request-scope.js';
import type { RequestScope } from '../../request-scope.js';
import { traceEvent } from '../../trace.js';
import type { ToolExecutionOptions, ToolResult } from '../../types.js';
import {
  buildUpstreamSkillRawFromContext,
  type BoardSource,
  inferCategoryFromProducer,
  resolveAuthoritativeBoardPayload,
  resolveHistoricalBoardContent,
  resolveHistoricalUpstreamSkillRaw,
  resolveUpstreamSkillRaw,
  summarizeUpstreamArtifact,
  type ResolvedBoardPayload,
} from './interpret-xuanxue-board.js';
import { formatBoardForAi, hasBoardFormatter } from './board-formatters/index.js';
import { interpretXuanxuePrompt } from './interpret-xuanxue-prompt.js';
import {
  createMissingBoardDataResult,
  hasOfficialBoardEvidence,
  isValidPastedBoardInput,
  PASTED_BOARD_GUIDANCE,
  validateBoardDataPresence,
} from './interpret-xuanxue-validation.js';
import { isUserPastedBoardSkill } from '../../pasted-board-context.js';
import {
  formatForceInjected,
  partitionUserSkills,
  planKnowledgeContext,
  type RuntimeKnowledgeSkill,
} from './xuanxue-knowledge.js';
import {
  createXuanxueActionContract,
  type XuanxueActionContractRun,
} from './xuanxue-action-contract.js';
import { setXuanxueKnowledgeToolState } from './xuanxue-knowledge-tools.js';

export { interpretXuanxuePrompt };

type PastedBoardInput = NonNullable<ToolExecutionOptions['pastedBoard']>;
type ContentSource = 'skill' | 'user';
type KnowledgePlan = ReturnType<typeof planKnowledgeContext>;
const KNOWLEDGE_QUERY_PREVIEW_MAX_CHARS = 80;

function buildFollowupDeltaExtraContext(
  previous: NonNullable<ReturnType<typeof getLatestFollowupInterpretation>>,
): string {
  const parts = [
    '【上一轮解读结论】',
    previous.interpretationOutput,
  ];
  if (previous.boardSkill && previous.boardOutput) {
    const boardOutput = hasBoardFormatter(previous.boardSkill)
      ? formatBoardForAi({
          skill: previous.boardSkill,
          output: previous.boardOutput,
          artifactData: previous.boardArtifactData,
        })
      : previous.boardOutput;
    parts.push(
      `【上一轮对应原盘来源】${previous.boardSkill}`,
      boardOutput,
    );
  }
  parts.push(
    '【本轮任务要求】这是对上一轮解读的追问或补充条件分析。请在上一轮结论基础上，重点说明新增条件带来的变化，不要把整盘从头完整重解一遍。',
  );
  return parts.join('\n\n');
}

function rejectMissingBoardData(args: {
  reason: string;
  contentSource: ContentSource;
  boardSource: BoardSource;
  requestScope?: RequestScope;
  hasUpstreamArtifact: boolean;
}): ToolResult {
  log(`interpret_xuanxue | 数据校验失败: ${args.reason}`);
  traceEvent({
    type: 'xuanxue_validation_rejected',
    reason: args.reason,
    contentSource: args.contentSource,
    boardSource: args.boardSource,
    hasUpstreamArtifact: args.hasUpstreamArtifact,
  }, args.requestScope);
  return createMissingBoardDataResult(args.reason);
}

async function loadEffectiveUserSkills(
  userId: string | undefined,
  deps: AgentRuntimeDeps,
): Promise<RuntimeKnowledgeSkill[]> {
  if (!userId) return [];
  try {
    const skills = await deps.skillCatalog.listEffectiveUserSkills(userId);
    const hydrated: RuntimeKnowledgeSkill[] = [];
    for (const skill of skills) {
      const content = await deps.skillCatalog.readTextSkillBundle?.(skill);
      if (!content?.trim()) continue;
      hydrated.push({
        dir: skill.dir,
        name: skill.name,
        description: skill.description,
        trigger: skill.trigger,
        content,
        category: skill.category,
        category_normalized: skill.category_normalized,
        match_keywords: skill.match_keywords,
        match_patterns: skill.match_patterns,
        example_queries: skill.example_queries,
        priority: skill.priority,
        usage_mode: skill.usage_mode,
        source: skill.source,
      });
    }
    return hydrated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`interpret_xuanxue | listEffectiveUserSkills 失败: ${msg}`);
    return [];
  }
}

function resolvePastedBoard(
  options?: ToolExecutionOptions,
): PastedBoardInput | undefined {
  if (options?.inputKind !== 'user_pasted_board') return undefined;
  return isValidPastedBoardInput(options.pastedBoard)
    ? options.pastedBoard
    : undefined;
}

function buildMergedQuestion(args: {
  rawQuestion?: string;
  pastedBoard?: PastedBoardInput;
  analysisMode: 'followup_delta' | 'full';
}): string | undefined {
  if (args.pastedBoard) return args.pastedBoard.question;
  if (args.analysisMode !== 'followup_delta') return args.rawQuestion;
  return [
    '这是对上一轮解读的补充追问。请基于已有结论和新增条件做增量分析，不要完整重解整盘。',
    args.rawQuestion,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function summarizeKnowledgeQuery(question?: string): string | undefined {
  if (typeof question !== 'string') return undefined;
  const normalized = question.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= KNOWLEDGE_QUERY_PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, KNOWLEDGE_QUERY_PREVIEW_MAX_CHARS)}...`;
}

function createPastedBoardPayload(
  pastedBoard: PastedBoardInput,
): ResolvedBoardPayload {
  return {
    boardSource: 'explicit_user_board',
    authoritativeContent: pastedBoard.content,
    upstreamSkillRaw: null,
    modelPreparedContentNote: null,
    resolverReason: 'user_pasted_board_protocol',
    resolverConfidence: 1,
    boardResolverUsed: false,
  };
}

function resolveActiveBoardPayload(
  options?: ToolExecutionOptions,
): ResolvedBoardPayload | null {
  const activeBoard = options?.activeBoardContext;
  if (
    !activeBoard ||
    typeof activeBoard.skill !== 'string' ||
    typeof activeBoard.output !== 'string' ||
    activeBoard.output.trim().length === 0
  ) {
    return null;
  }

  const upstreamSkillRaw = buildUpstreamSkillRawFromContext(activeBoard);
  return {
    boardSource: 'active_board_context',
    authoritativeContent: hasBoardFormatter(upstreamSkillRaw.skill)
      ? formatBoardForAi({
          skill: upstreamSkillRaw.skill,
          output: upstreamSkillRaw.rawOutput,
          artifactData: upstreamSkillRaw.payload,
        })
      : upstreamSkillRaw.payload && typeof upstreamSkillRaw.payload === 'object'
        ? JSON.stringify(upstreamSkillRaw.payload, null, 2)
        : upstreamSkillRaw.rawOutput,
    upstreamSkillRaw,
    modelPreparedContentNote: null,
    resolverReason: 'explicit_active_board_context',
    resolverConfidence: 1,
    boardResolverUsed: false,
  };
}

function buildMergedExtraContext(args: {
  externalExtraContext?: string;
  modelPreparedContentNote: string | null;
  analysisMode: 'followup_delta' | 'full';
  latestFollowupInterpretation: ReturnType<typeof getLatestFollowupInterpretation>;
}): string {
  return [
    args.externalExtraContext,
    args.modelPreparedContentNote,
    args.analysisMode === 'followup_delta' && args.latestFollowupInterpretation
      ? buildFollowupDeltaExtraContext(args.latestFollowupInterpretation)
      : null,
  ]
    .filter((item): item is string => Boolean(item && item.trim()))
    .join('\n\n');
}

function emitKnowledgePolicyTrace(args: {
  currentCategory: string | undefined;
  argCategory: string | undefined;
  inferredCategory: string | undefined;
  effectiveCategory: string | undefined;
  knowledgePlan: KnowledgePlan;
  requestScope?: RequestScope;
}): void {
  const { forceInjected, queryable } = args.knowledgePlan;
  traceEvent({
    type: 'xuanxue_policy_resolved',
    category: args.currentCategory,
    argCategory: args.argCategory,
    inferredCategory: args.inferredCategory,
    effectiveCategory: args.effectiveCategory,
    matchedUserSkillCount: 0,
    forceSkillDirs: forceInjected.map((item) => item.skill_dir),
    forceSkillNames: forceInjected.map((item) => item.skill_name),
    queryableSkillDirs: queryable.map((item) => item.skill_dir),
    queryableSkillNames: queryable.map((item) => item.skill_name),
    questionFacets: args.knowledgePlan.questionFacets,
    topicFacets: args.knowledgePlan.topicFacets,
    actionFacets: args.knowledgePlan.actionFacets,
  }, args.requestScope);
}

function emitInterpretationPreparedTrace(args: {
  currentCategory: string | undefined;
  contentSource: ContentSource;
  boardPayload: ResolvedBoardPayload;
  analysisMode: 'followup_delta' | 'full';
  queryText?: string;
  upstreamSummary: ReturnType<typeof summarizeUpstreamArtifact>;
  authoritativeContent: string;
  modelPreparedContentNote: string | null;
  forceInjected: KnowledgePlan['forceInjected'];
  queryable: KnowledgePlan['queryable'];
  knowledgePlan: KnowledgePlan;
  requestScope?: RequestScope;
}): void {
  const upstreamSkillRaw = args.boardPayload.upstreamSkillRaw;
  const queryText = summarizeKnowledgeQuery(args.queryText);
  log(
    `interpret_xuanxue | category=${args.currentCategory || '未指定'} | query=${queryText || '未提供'} | contentSource=${args.contentSource} | boardSource=${args.boardPayload.boardSource} | analysisMode=${args.analysisMode} | upstream=${upstreamSkillRaw?.skill || '无'} | resolver=${args.boardPayload.boardResolverUsed ? 'yes' : 'no'} | force=${args.forceInjected.length}[${args.forceInjected.map((item) => item.skill_dir).join(',')}] queryable=${args.queryable.length}[${args.queryable.map((item) => item.skill_dir).join(',')}] topicFacets=[${args.knowledgePlan.topicFacets.join(',')}] actionFacets=[${args.knowledgePlan.actionFacets.join(',')}] | upstreamRaw=${args.upstreamSummary.line}`,
  );
  traceEvent({
    type: 'xuanxue_interpretation_started',
    force: args.forceInjected.length,
    queryable: args.queryable.length,
    category: args.currentCategory,
    queryText,
    hasContextHints: false,
    contentSource: args.contentSource,
    analysisMode: args.analysisMode,
    contentMode: args.boardPayload.boardSource,
    boardSource: args.boardPayload.boardSource,
    boardResolverUsed: args.boardPayload.boardResolverUsed,
    boardResolverReason: args.boardPayload.resolverReason,
    boardResolverConfidence: args.boardPayload.resolverConfidence,
    authoritativeContentBytes: args.authoritativeContent.length,
    hasUpstreamArtifact: !!upstreamSkillRaw,
    upstreamSkillName: upstreamSkillRaw?.skill,
    usedModelPreparedNote: !!args.modelPreparedContentNote,
    forceSkillDirs: args.forceInjected.map((item) => item.skill_dir),
    forceSkillNames: args.forceInjected.map((item) => item.skill_name),
    queryableSkillDirs: args.queryable.map((item) => item.skill_dir),
    queryableSkillNames: args.queryable.map((item) => item.skill_name),
    questionFacets: args.knowledgePlan.questionFacets,
    topicFacets: args.knowledgePlan.topicFacets,
    actionFacets: args.knowledgePlan.actionFacets,
    ...args.upstreamSummary.trace,
  }, args.requestScope);
}

async function pushKnowledgeHitProgress(args: {
  deps: AgentRuntimeDeps;
  requestId?: string;
  forceInjected: KnowledgePlan['forceInjected'];
  queryable: KnowledgePlan['queryable'];
}): Promise<void> {
  const allKnowledgeSkills = [
    ...args.forceInjected.map((item) => item.skill_name),
    ...args.queryable.map((item) => item.skill_name),
  ];
  if (allKnowledgeSkills.length === 0 || !args.requestId) return;

  const { accountId } = getContext();
  await args.deps.messageBus.pushOutbox(accountId, {
    type: 'progress',
    accountId,
    requestId: args.requestId,
    text: `命中相关知识库：${allKnowledgeSkills.join('、')}`,
    timestamp: new Date().toISOString(),
    metadata: {
      kind: 'knowledge_hit',
      stage: 'knowledge_hit',
      skillNames: allKnowledgeSkills,
    },
  });
}

async function pushKnowledgeRetrievingProgress(args: {
  deps: AgentRuntimeDeps;
  requestId?: string;
  queryText?: string;
}): Promise<void> {
  if (!args.requestId) return;
  const { accountId } = getContext();
  const queryText = summarizeKnowledgeQuery(args.queryText);
  await args.deps.messageBus.pushOutbox(accountId, {
    type: 'progress',
    accountId,
    requestId: args.requestId,
    text: queryText ? `开始解读：${queryText}` : '开始解读',
    timestamp: new Date().toISOString(),
    metadata: {
      kind: 'knowledge_retrieving',
      stage: 'knowledge_retrieving',
      query_text: queryText,
    },
  });
}

function buildKnowledgeSummary(args: {
  authoritativeContent: string;
  mergedQuestion?: string;
  currentCategory: string | undefined;
  mergedExtraContext: string;
  boardPayload: ResolvedBoardPayload;
  forceInjected: KnowledgePlan['forceInjected'];
  queryable: KnowledgePlan['queryable'];
  analysisMode: 'followup_delta' | 'full';
  actionContract?: XuanxueActionContractRun;
}): string {
  return JSON.stringify(
    {
      instruction:
        '请基于 authoritativeContent 完成玄学解读。userKnowledge.requiredContent 是必须遵守的用户知识正文；如果其中包含输出格式要求，final_reply 必须按该格式输出。必要时调用 list_knowledge_sections/read_knowledge_section 读取用户知识库，最后必须用 final_reply 输出最终解读。',
      category: args.currentCategory,
      question: args.mergedQuestion,
      analysisMode: args.analysisMode,
      boardSource: args.boardPayload.boardSource,
      resolver: {
        used: args.boardPayload.boardResolverUsed,
        reason: args.boardPayload.resolverReason,
        confidence: args.boardPayload.resolverConfidence,
      },
      upstreamSkill: args.boardPayload.upstreamSkillRaw?.skill,
      extraContext: args.mergedExtraContext || undefined,
      authoritativeContent: args.authoritativeContent,
      userKnowledge: {
        requiredContent: formatForceInjected(args.forceInjected) || undefined,
        forceInjected: args.forceInjected.map((bundle) => ({
          skill_dir: bundle.skill_dir,
          skill_name: bundle.skill_name,
        })),
        queryable: args.queryable.map((bundle) => ({
          skill_dir: bundle.skill_dir,
          skill_name: bundle.skill_name,
          sections: bundle.sections.map((section) => section.title),
        })),
        actionContractRunId: args.actionContract?.run.runId,
      },
    },
    null,
    2,
  );
}

function emitInterpretationPromptTrace(args: {
  currentCategory: string | undefined;
  output: string;
  authoritativeContent: string;
  mergedQuestion?: string;
  mergedExtraContext: string;
  boardPayload: ResolvedBoardPayload;
  forceInjected: KnowledgePlan['forceInjected'];
  queryable: KnowledgePlan['queryable'];
  requestScope?: RequestScope;
}): void {
  traceEvent({
    type: 'interpret_xuanxue_prompt_prepared',
    category: args.currentCategory,
    boardSource: args.boardPayload.boardSource,
    upstreamSkillName: args.boardPayload.upstreamSkillRaw?.skill,
    promptBytes: Buffer.byteLength(args.output, 'utf8'),
    authoritativeContentBytes: Buffer.byteLength(
      args.authoritativeContent,
      'utf8',
    ),
    question: args.mergedQuestion,
    extraContextBytes: args.mergedExtraContext
      ? Buffer.byteLength(args.mergedExtraContext, 'utf8')
      : 0,
    forceSkillDirs: args.forceInjected.map((item) => item.skill_dir),
    queryableSkillDirs: args.queryable.map((item) => item.skill_dir),
    // interpret_xuanxue 不启动独立子模型；这个 output 是工具结果，
    // 会作为下一轮模型输入注入当前 specialist loop。
    runtimePrompt: args.output,
    runtimePromptChunks: chunkTraceText(args.output),
  }, args.requestScope);
}

function chunkTraceText(text: string): string[] {
  const chunkSize = 3800;
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += chunkSize) {
    chunks.push(text.slice(start, start + chunkSize));
  }
  return chunks.length > 0 ? chunks : [''];
}

export async function executeInterpretXuanxue(
  args: Record<string, unknown>,
  options?: ToolExecutionOptions,
): Promise<ToolResult> {
  if (!options?.llmRuntime) {
    return {
      output: 'interpret_xuanxue 缺少请求级 llmRuntime。',
      isError: true,
    };
  }

  const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();
  const pastedBoard = resolvePastedBoard(options);
  const activeBoardPayload = pastedBoard ? null : resolveActiveBoardPayload(options);
  if (options?.inputKind === 'user_pasted_board' && !pastedBoard) {
    return createMissingBoardDataResult(
      '自贴盘面入口缺少完整 pastedBoard.category/content/question。',
    );
  }

  const latestFollowupInterpretation = options?.requestScope
    ? getLatestFollowupInterpretation(options.requestScope)
    : null;
  const rawArgCategory =
    pastedBoard?.category ||
    inferCategoryFromProducer(activeBoardPayload?.upstreamSkillRaw?.skill) ||
    (args.category as string | undefined) ||
    undefined;
  const argCategory = rawArgCategory
    ? normalizeCategoryName(rawArgCategory) ?? rawArgCategory
    : undefined;
  const rawArgContent =
    pastedBoard?.content ||
    (typeof args.content === 'string' ? (args.content as string) : '');
  const externalExtraContext =
    (args.extra_context as string | undefined) || undefined;
  const contentSource: ContentSource =
    pastedBoard || (args.content_source as string | undefined) === 'user'
      ? 'user'
      : 'skill';

  if (contentSource === 'user' && !pastedBoard) {
    return rejectMissingBoardData({
      reason:
        `普通聊天消息不能直接使用用户原文作为盘面依据解读。${PASTED_BOARD_GUIDANCE}`,
      contentSource,
      boardSource: 'explicit_user_board',
      requestScope: options?.requestScope,
      hasUpstreamArtifact: false,
    });
  }

  const requestedCategory = argCategory;
  const hasPreviousInterpretation = Boolean(
    !pastedBoard && latestFollowupInterpretation?.interpretationOutput.trim(),
  );
  const analysisMode = hasPreviousInterpretation ? 'followup_delta' : 'full';
  const earlyArtifact = options?.requestScope
    ? latestSkillArtifactExcluding(options.requestScope, ['xuanxue-jiedu'])
    : null;
  const inferredCategory = inferCategoryFromProducer(earlyArtifact?.producer);
  const currentRequestUpstreamSkillRaw = resolveUpstreamSkillRaw({
    contentSource,
    currentCategory: requestedCategory,
    requestScope: options?.requestScope,
  });
  const historicalUpstreamSkillRaw = currentRequestUpstreamSkillRaw
    ? null
    : resolveHistoricalUpstreamSkillRaw(
        latestFollowupInterpretation,
        requestedCategory,
      );
  const historicalBoardContent = resolveHistoricalBoardContent(
    latestFollowupInterpretation,
    requestedCategory,
  );
  const hasHistoricalPastedBoardEvidence = Boolean(
    historicalUpstreamSkillRaw &&
      isUserPastedBoardSkill(historicalUpstreamSkillRaw.skill),
  );
  const mergedQuestion = buildMergedQuestion({
    rawQuestion: args.question as string | undefined,
    pastedBoard,
    analysisMode,
  });

  if (
    !pastedBoard &&
    !activeBoardPayload &&
    !hasOfficialBoardEvidence({
      currentRequestUpstreamSkillRaw,
      historicalUpstreamSkillRaw,
      historicalBoardContent,
    }) &&
    !hasHistoricalPastedBoardEvidence
  ) {
    return rejectMissingBoardData({
      reason: `未找到官方排盘 skill 的原始产出。${PASTED_BOARD_GUIDANCE}`,
      contentSource,
      boardSource: 'model_content_fallback',
      requestScope: options?.requestScope,
      hasUpstreamArtifact: false,
    });
  }

  const boardPayload = pastedBoard
    ? createPastedBoardPayload(pastedBoard)
    : activeBoardPayload ??
      (await resolveAuthoritativeBoardPayload({
        rawArgContent,
        argContentSource: contentSource,
        currentUserMessage: mergedQuestion || rawArgContent || '',
        question: mergedQuestion,
        contextHints: null,
        latestFollowupInterpretation,
        currentRequestUpstreamSkillRaw,
        historicalUpstreamSkillRaw,
        historicalBoardContent,
        requestScope: options?.requestScope,
        delegationGoal: options?.delegationGoal,
        llmRuntime: options.llmRuntime,
      }));
  const upstreamSkillRaw = boardPayload.upstreamSkillRaw;
  const validation = validateBoardDataPresence({
    upstreamArtifact: upstreamSkillRaw,
    boardSource: boardPayload.boardSource,
    contentSource,
    inputKind: options?.inputKind,
  });
  if (!validation.valid) {
    return rejectMissingBoardData({
      reason: validation.reason,
      contentSource,
      boardSource: boardPayload.boardSource,
      requestScope: options?.requestScope,
      hasUpstreamArtifact: !!upstreamSkillRaw,
    });
  }

  const userSkills = await loadEffectiveUserSkills(getContext().userId, deps);
  const upstreamSummary = summarizeUpstreamArtifact(upstreamSkillRaw);
  const officialCategory = !pastedBoard
    ? inferCategoryFromProducer(
        upstreamSkillRaw?.skill ||
          currentRequestUpstreamSkillRaw?.skill ||
          historicalUpstreamSkillRaw?.skill ||
          latestFollowupInterpretation?.boardSkill ||
          earlyArtifact?.producer,
      )
    : undefined;
  const currentCategory = officialCategory || requestedCategory;
  const effectiveCategory = currentCategory || inferredCategory;
  const authoritativeContent = boardPayload.authoritativeContent;
  const modelPreparedContentNote = boardPayload.modelPreparedContentNote;
  const knowledgeQueryText = summarizeKnowledgeQuery(mergedQuestion);
  const mergedExtraContext = buildMergedExtraContext({
    externalExtraContext,
    modelPreparedContentNote,
    analysisMode,
    latestFollowupInterpretation,
  });
  const buckets = partitionUserSkills(userSkills, null, effectiveCategory);
  const knowledgePlan = planKnowledgeContext(buckets);
  const { forceInjected, queryable } = knowledgePlan;
  const actionContract = createXuanxueActionContract({
    queryable,
    question: mergedQuestion,
    category: effectiveCategory,
    provider: options?.llmRuntime?.provider,
    model: options?.llmRuntime?.model,
    requestScope: options?.requestScope,
  });

  emitKnowledgePolicyTrace({
    currentCategory,
    argCategory,
    inferredCategory,
    effectiveCategory,
    knowledgePlan,
    requestScope: options?.requestScope,
  });
  emitInterpretationPreparedTrace({
    currentCategory,
    contentSource,
    boardPayload,
    analysisMode,
    queryText: knowledgeQueryText,
    upstreamSummary,
    authoritativeContent,
    modelPreparedContentNote,
    forceInjected,
    queryable,
    knowledgePlan,
    requestScope: options?.requestScope,
  });

  const requestId = options?.requestScope
    ? getRequestId(options.requestScope)
    : undefined;
  await pushKnowledgeHitProgress({
    deps,
    requestId,
    forceInjected,
    queryable,
  });
  await pushKnowledgeRetrievingProgress({
    deps,
    requestId,
    queryText: knowledgeQueryText,
  });
  if (options?.loopRunId) {
    setXuanxueKnowledgeToolState(options.loopRunId, { queryable });
  }

  const output = buildKnowledgeSummary({
    authoritativeContent,
    mergedQuestion,
    currentCategory,
    mergedExtraContext,
    boardPayload,
    forceInjected,
    queryable,
    analysisMode,
    actionContract,
  });
  emitInterpretationPromptTrace({
    currentCategory,
    output,
    authoritativeContent,
    mergedQuestion,
    mergedExtraContext,
    boardPayload,
    forceInjected,
    queryable,
    requestScope: options?.requestScope,
  });
  return {
    output,
    isError: false,
    passthroughSafe: true,
  };
}
