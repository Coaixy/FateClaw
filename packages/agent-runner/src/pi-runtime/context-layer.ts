import { resolveEvidenceCategoryBySkill } from '../evidence-policy.js';
import { log } from '../io.js';
import { buildUserPastedBoardSkillContext } from '../pasted-board-context.js';
import {
  setLatestFollowupInterpretation,
  type FollowupInterpretationContext,
  type RequestScope,
} from '../request-scope.js';
import { traceEvent } from '../trace.js';
import type {
  ContainerInput,
  HistoryMessage,
  SkillContextEntry,
} from '../types.js';
import type { RequestRuntime } from '../runtime.js';

const PROMPT_BUDGET_RATIO = 0.5;
const MIN_CONTEXT_BUDGET_CHARS = 16_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_HISTORY_MESSAGES = 24;
const TOOL_CONTEXT_PREVIEW_CHARS = 4_000;
const MEMORY_PREVIEW_CHARS = 2_000;
const HISTORY_STORE_PREVIEW_CHARS = 1_200;
const KNOWLEDGE_INDEX_LIMIT = 80;
const KNOWLEDGE_SECTION_PREVIEW_CHARS = 2_400;

type ProvenanceSource =
  | 'request'
  | 'history'
  | 'database'
  | 'memory'
  | 'knowledge'
  | 'compression';

export interface PiContextProvenanceEntry {
  id: string;
  source: ProvenanceSource;
  title: string;
  detail?: string;
  bytes: number;
  retained: boolean;
}

interface PiContextSection {
  id: string;
  title: string;
  source: ProvenanceSource;
  priority: number;
  content: string;
  omittedContent?: string;
  detail?: string;
  alwaysKeep?: boolean;
}

export interface PiSessionContext {
  /** 追加到 Pi system prompt 的请求上下文；真实用户输入必须单独作为 user prompt 发送。 */
  prompt: string;
  followupContext: FollowupInterpretationContext | null;
  persistedSkillContext: SkillContextEntry[];
  provenance: PiContextProvenanceEntry[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function stringifyPayload(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() ? value : null;
  }
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolContextEntry(entry: SkillContextEntry): string {
  const parts = [
    `skill=${entry.skill}`,
    entry.artifactType ? `artifactType=${entry.artifactType}` : '',
    entry.artifactTitle ? `artifactTitle=${entry.artifactTitle}` : '',
    'output:',
    truncateMiddle(entry.output, TOOL_CONTEXT_PREVIEW_CHARS),
  ];
  const artifactData = stringifyPayload(entry.artifactData);
  if (artifactData) {
    parts.push('artifactData:', truncateMiddle(artifactData, TOOL_CONTEXT_PREVIEW_CHARS));
  }
  return parts.filter(Boolean).join('\n');
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - 80);
  return [
    value.slice(0, head),
    `\n...[已由 Pi context layer 压缩，省略 ${value.length - head - tail} 字符]...\n`,
    tail > 0 ? value.slice(value.length - tail) : '',
  ].join('');
}

function createSection(args: Omit<PiContextSection, 'content'> & {
  lines: Array<string | null | undefined>;
}): PiContextSection | null {
  const content = args.lines
    .filter((line): line is string => line !== undefined && line !== null)
    .join('\n')
    .trim();
  if (!content) return null;
  return {
    id: args.id,
    title: args.title,
    source: args.source,
    priority: args.priority,
    content,
    detail: args.detail,
    omittedContent: args.omittedContent,
    alwaysKeep: args.alwaysKeep,
  };
}

function estimatePromptBudgetChars(input: ContainerInput): number {
  const contextWindow =
    input.llmRuntime.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.max(
    MIN_CONTEXT_BUDGET_CHARS,
    Math.floor(contextWindow * APPROX_CHARS_PER_TOKEN * PROMPT_BUDGET_RATIO),
  );
}

function collectHistoryToolContext(history: HistoryMessage[]): SkillContextEntry[] {
  const entries: SkillContextEntry[] = [];
  for (const message of history) {
    for (const entry of message.toolContext ?? []) {
      const exists = entries.some(
        (item) => item.skill === entry.skill && item.output === entry.output,
      );
      if (!exists) entries.push(entry);
    }
  }
  return entries;
}

function extractLatestFollowupInterpretation(
  history: ContainerInput['history'],
  category: string | null | undefined,
): FollowupInterpretationContext | null {
  if (!category) return null;

  let interpretationOutput = '';
  let boardSkill: string | undefined;
  let boardOutput: string | undefined;
  let boardArtifactData: unknown;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const toolContext = history[i].toolContext ?? [];
    if (toolContext.length === 0) continue;

    if (!interpretationOutput) {
      const interpretation = toolContext.find(
        (entry) => entry.skill === 'xuanxue-jiedu',
      );
      interpretationOutput = interpretation?.output ?? '';
    }

    if (!boardSkill) {
      const board = toolContext.find(
        (entry) => resolveEvidenceCategoryBySkill(entry.skill) === category,
      );
      if (board) {
        boardSkill = board.skill;
        boardOutput = board.output;
        boardArtifactData = board.artifactData;
      }
    }

    if (interpretationOutput && boardSkill) break;
  }

  if (!interpretationOutput && !boardSkill) return null;
  return {
    category,
    interpretationOutput,
    boardSkill,
    boardOutput,
    boardArtifactData,
  };
}

function resolveFollowupContextFromHistory(
  input: ContainerInput,
): FollowupInterpretationContext | null {
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const toolContext = input.history[i].toolContext ?? [];
    if (toolContext.length === 0) continue;

    const board = toolContext.find(
      (entry) => resolveEvidenceCategoryBySkill(entry.skill) !== null,
    );
    const interpretation = toolContext.find(
      (entry) => entry.skill === 'xuanxue-jiedu',
    );
    if (!board && !interpretation) continue;

    const category = board
      ? resolveEvidenceCategoryBySkill(board.skill)
      : null;
    if (!category) continue;
    return extractLatestFollowupInterpretation(input.history, category);
  }
  return null;
}

async function resolveLatestFollowupInterpretationContext(args: {
  containerInput: ContainerInput;
  runtime: RequestRuntime;
  requestScope: RequestScope;
}): Promise<FollowupInterpretationContext | null> {
  const fromHistory = resolveFollowupContextFromHistory(args.containerInput);
  if (fromHistory?.boardOutput || fromHistory?.boardArtifactData) {
    traceEvent({
      type: 'pi_context_followup_loaded',
      source: 'history',
      category: fromHistory.category,
      hasBoard: Boolean(fromHistory.boardSkill),
      hasInterpretation: Boolean(fromHistory.interpretationOutput),
    }, args.requestScope);
    return fromHistory;
  }

  const category = fromHistory?.category;
  try {
    const fromDb =
      await args.runtime.deps.workflowContextStore?.latestFollowupContext({
        accountId: args.containerInput.accountId,
        category,
        sessionId: args.containerInput.sessionId,
      });
    const resolved = fromDb ?? fromHistory;
    if (resolved) {
      traceEvent({
        type: 'pi_context_followup_loaded',
        source: fromDb ? 'database' : 'history',
        category: resolved.category,
        hasBoard: Boolean(resolved.boardSkill),
        hasInterpretation: Boolean(resolved.interpretationOutput),
      }, args.requestScope);
    }
    return resolved;
  } catch (error) {
    log(
      `pi context followup db fallback failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fromHistory;
  }
}

function buildBoardSkillContextFromFollowup(
  context: FollowupInterpretationContext | null,
): SkillContextEntry | null {
  if (!context?.boardSkill) return null;
  if (!context.boardOutput && context.boardArtifactData === undefined) {
    return null;
  }

  return {
    skill: context.boardSkill,
    output:
      context.boardOutput ??
      JSON.stringify(context.boardArtifactData, null, 2),
    artifactType: `skill.${context.boardSkill}`,
    artifactTitle: `Skill 结果: ${context.boardSkill}`,
    artifactData: context.boardArtifactData,
  };
}

function buildPersistedSkillContext(args: {
  containerInput: ContainerInput;
  followupContext: FollowupInterpretationContext | null;
}): SkillContextEntry[] {
  const referencedBoardContext =
    args.containerInput.inputKind === 'user_pasted_board' &&
    args.containerInput.pastedBoard
      ? buildUserPastedBoardSkillContext(args.containerInput.pastedBoard)
      : args.containerInput.activeBoardContext
        ? {
            skill: args.containerInput.activeBoardContext.skill,
            output: args.containerInput.activeBoardContext.output,
            artifactType: args.containerInput.activeBoardContext.artifactType,
            artifactTitle: args.containerInput.activeBoardContext.artifactTitle,
            artifactData: args.containerInput.activeBoardContext.artifactData,
          }
      : buildBoardSkillContextFromFollowup(args.followupContext);

  return referencedBoardContext ? [referencedBoardContext] : [];
}

function buildCurrentInputSection(input: ContainerInput): PiContextSection[] {
  const sections: PiContextSection[] = [];
  const current = createSection({
    id: 'current_request_metadata',
    title: '当前请求元数据',
    source: 'request',
    priority: 100,
    alwaysKeep: true,
    lines: [
      `inputKind=${input.inputKind ?? 'normal'}`,
      '用户原始输入已直接作为 Pi user prompt 发送；本上下文不重复包装用户消息。',
    ],
  });
  if (current) sections.push(current);

  if (input.activeBoardContext) {
    const active = createSection({
      id: 'active_board_context',
      title: '当前选中盘面 activeBoardContext',
      source: 'request',
      priority: 95,
      alwaysKeep: true,
      lines: [
        `sourceMessageId=${input.activeBoardContext.sourceMessageId}`,
        formatToolContextEntry(input.activeBoardContext),
      ],
    });
    if (active) sections.push(active);
  }

  if (input.pastedBoard) {
    const pasted = createSection({
      id: 'pasted_board',
      title: '用户自贴盘面 pastedBoard',
      source: 'request',
      priority: 95,
      alwaysKeep: true,
      lines: [
        `category=${input.pastedBoard.category}`,
        `question=${input.pastedBoard.question}`,
        input.pastedBoard.content,
      ],
    });
    if (pasted) sections.push(pasted);
  }

  return sections;
}

function formatHistoryMessage(message: HistoryMessage, index: number): string {
  const toolContext = message.toolContext?.length
    ? [
        '[历史 toolContext]',
        ...message.toolContext.map(formatToolContextEntry),
      ].join('\n\n')
    : '';
  return [
    `#${index + 1} role=${message.role}${message.timestamp ? ` timestamp=${message.timestamp}` : ''}`,
    message.content,
    toolContext,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildHistorySections(input: ContainerInput): PiContextSection[] {
  const recentHistory = input.history.slice(-MAX_HISTORY_MESSAGES);
  const omitted = Math.max(0, input.history.length - recentHistory.length);
  const history = createSection({
    id: 'session_history',
    title: '当前 session 历史',
    source: 'history',
    priority: 70,
    lines: [
      omitted > 0
        ? `较早 ${omitted} 条消息已由 Pi context layer 裁剪；需要更早内容时调用 recall_history。`
        : null,
      ...recentHistory.map(formatHistoryMessage),
    ],
  });

  const allToolContext = collectHistoryToolContext(input.history);
  const toolContext = createSection({
    id: 'historical_tool_context',
    title: '历史 toolContext 索引',
    source: 'history',
    priority: 85,
    lines: allToolContext.map((entry, index) =>
      [`#${index + 1}`, formatToolContextEntry(entry)].join('\n'),
    ),
  });
  const artifacts = createSection({
    id: 'historical_artifacts',
    title: '历史 artifact 索引',
    source: 'history',
    priority: 80,
    lines: allToolContext.flatMap((entry, index) => {
      const artifact = stringifyPayload(entry.artifactData);
      if (!entry.artifactType && !entry.artifactTitle && !artifact) return [];
      return [
        [
          `#${index + 1}`,
          `skill=${entry.skill}`,
          entry.artifactType ? `artifactType=${entry.artifactType}` : '',
          entry.artifactTitle ? `artifactTitle=${entry.artifactTitle}` : '',
          artifact
            ? `artifactData:\n${truncateMiddle(artifact, TOOL_CONTEXT_PREVIEW_CHARS)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ];
    }),
  });

  return [history, toolContext, artifacts].filter((item): item is PiContextSection =>
    Boolean(item),
  );
}

function buildFollowupSection(
  context: FollowupInterpretationContext | null,
): PiContextSection | null {
  if (!context) return null;
  return createSection({
    id: 'followup_context',
    title: 'Pi 会话连续性上下文',
    source: 'history',
    priority: 90,
    lines: [
      `category=${context.category}`,
      context.boardSkill ? `boardSkill=${context.boardSkill}` : null,
      context.boardOutput
        ? `boardOutput:\n${truncateMiddle(context.boardOutput, TOOL_CONTEXT_PREVIEW_CHARS)}`
        : null,
      context.boardArtifactData !== undefined
        ? `boardArtifactData:\n${truncateMiddle(stringifyPayload(context.boardArtifactData) ?? '', TOOL_CONTEXT_PREVIEW_CHARS)}`
        : null,
      context.interpretationOutput
        ? `previousInterpretation:\n${truncateMiddle(context.interpretationOutput, TOOL_CONTEXT_PREVIEW_CHARS)}`
        : null,
      '连续性说明：用户追问、补充条件或只回复参数片段时，优先基于此上下文判断是否继续上一轮任务；是否增量分析由 Pi 决定。',
    ],
  });
}

async function buildMemorySection(args: {
  input: ContainerInput;
  runtime: RequestRuntime;
}): Promise<PiContextSection | null> {
  try {
    const content = await args.runtime.deps.memoryStore.read(args.input.accountId);
    if (!content.trim()) return null;
    return createSection({
      id: 'long_term_memory',
      title: '长期记忆摘要/全文策略',
      source: 'memory',
      priority: 55,
      lines: [
        content.length > MEMORY_PREVIEW_CHARS
          ? [
              truncateMiddle(content, MEMORY_PREVIEW_CHARS),
              '策略：这里只注入长期记忆摘要；需要确认未展示的长期记忆全文时调用 read_memory。',
            ].join('\n')
          : [
              content,
              '策略：当前长期记忆已完整注入；如需修改必须先 read_memory 再 write_memory 写回完整内容。',
            ].join('\n'),
      ],
    });
  } catch (error) {
    log(
      `pi context memory load failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function buildHistoryStoreSection(args: {
  input: ContainerInput;
  runtime: RequestRuntime;
}): Promise<PiContextSection | null> {
  try {
    const raw = await args.runtime.deps.historyStore.listRecent(
      args.input.accountId,
      12,
    );
    const lines = raw.flatMap((entry, index) => {
      try {
        const parsed = JSON.parse(entry) as {
          sender_name?: string;
          content?: string;
          timestamp?: string;
          is_from_me?: boolean;
        };
        const role = parsed.is_from_me ? 'assistant' : parsed.sender_name || 'user';
        return [
          `#${index + 1} role=${role}${parsed.timestamp ? ` timestamp=${parsed.timestamp}` : ''}`,
          truncateMiddle(parsed.content ?? '', HISTORY_STORE_PREVIEW_CHARS),
        ];
      } catch {
        return [];
      }
    });
    return createSection({
      id: 'recent_history_store',
      title: 'Redis 历史摘要',
      source: 'history',
      priority: 35,
      lines: [
        '此段只作为跨请求历史摘要；需要精确检索更早对话时调用 recall_history。',
        ...lines,
      ],
    });
  } catch {
    return null;
  }
}

async function buildKnowledgeSections(args: {
  userId?: string;
  runtime: RequestRuntime;
}): Promise<PiContextSection[]> {
  if (!args.userId) return [];
  try {
    const skills = await args.runtime.deps.skillCatalog.listEffectiveUserSkills(
      args.userId,
    );
    const visible = skills.slice(0, KNOWLEDGE_INDEX_LIMIT);
    const index = createSection({
      id: 'knowledge_index',
      title: '用户知识库索引',
      source: 'knowledge',
      priority: 60,
      lines: [
        visible.length < skills.length
          ? `知识库总数 ${skills.length}，当前索引保留前 ${visible.length} 个。`
          : `知识库总数 ${skills.length}。`,
        ...visible.map((skill) =>
          [
            `- ${skill.dir}`,
            `name=${skill.name}`,
            `category=${skill.category || '通用'}`,
            `source=${skill.source}`,
            `usageMode=${skill.usage_mode}`,
            `description=${skill.description || skill.trigger || ''}`,
            skill.match_keywords?.length
              ? `keywords=${skill.match_keywords.join(',')}`
              : '',
          ]
            .filter(Boolean)
            .join(' | '),
        ),
        '策略：命中用户知识库意图时，Pi 先用索引判断是否需要正文；reference_only 正文通过授权知识库工具读取。',
      ],
    });

    const forceContent: string[] = [];
    for (const skill of skills.filter(
      (item) => item.usage_mode === 'force_injected',
    )) {
      const content = await args.runtime.deps.skillCatalog.readTextSkillBundle?.(skill);
      if (!content?.trim()) continue;
      forceContent.push(
        [
          `## ${skill.dir} (${skill.name})`,
          truncateMiddle(content, KNOWLEDGE_SECTION_PREVIEW_CHARS),
        ].join('\n'),
      );
    }
    const required = createSection({
      id: 'required_knowledge_body',
      title: '必要的知识库正文',
      source: 'knowledge',
      priority: 75,
      lines: forceContent,
    });

    return [index, required].filter((item): item is PiContextSection =>
      Boolean(item),
    );
  } catch (error) {
    log(
      `pi context knowledge load failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function compactSections(args: {
  sections: PiContextSection[];
  budgetChars: number;
}): {
  sections: PiContextSection[];
  provenance: PiContextProvenanceEntry[];
} {
  const sorted = [...args.sections].sort((a, b) => b.priority - a.priority);
  const retained = new Set<string>();
  let total = 0;

  for (const section of sorted) {
    const size = byteLength(section.content);
    if (
      section.alwaysKeep ||
      total + size <= args.budgetChars ||
      retained.size === 0
    ) {
      retained.add(section.id);
      total += size;
    }
  }

  const kept = args.sections.filter((section) => retained.has(section.id));
  const provenance = args.sections.map((section) => ({
    id: section.id,
    source: section.source,
    title: section.title,
    detail: section.detail,
    bytes: byteLength(section.content),
    retained: retained.has(section.id),
  }));

  return { sections: kept, provenance };
}

function buildProvenanceSection(
  provenance: PiContextProvenanceEntry[],
): PiContextSection {
  return {
    id: 'context_provenance',
    title: '上下文 provenance 与压缩策略',
    source: 'compression',
    priority: 100,
    alwaysKeep: true,
    content: [
      'Pi context layer 是本轮上下文唯一入口。下列条目标明来源、字节数与是否保留。',
      ...provenance.map((entry) =>
        [
          `- ${entry.id}`,
          `source=${entry.source}`,
          `bytes=${entry.bytes}`,
          `retained=${entry.retained}`,
          entry.detail ? `detail=${entry.detail}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      ),
    ].join('\n'),
  };
}

function renderPrompt(sections: PiContextSection[]): string {
  return [
    '<fateclaw_pi_context>',
    ...sections.map((section) =>
      [
        `<context_section id="${section.id}" source="${section.source}" title="${section.title}">`,
        section.content,
        '</context_section>',
      ].join('\n'),
    ),
    '</fateclaw_pi_context>',
    '',
    '真实用户输入会作为 Pi user prompt 直接发送；请基于上述 Pi context 判断缺失信息、是否追问、是否需要工具和最终回复。不要要求外部 request boundary 替你决定上下文连续性。',
  ].join('\n');
}

export async function createPiSessionContext(args: {
  containerInput: ContainerInput;
  runtime: RequestRuntime;
  requestScope: RequestScope;
  userId?: string;
}): Promise<PiSessionContext> {
  const followupContext = await resolveLatestFollowupInterpretationContext({
    containerInput: args.containerInput,
    runtime: args.runtime,
    requestScope: args.requestScope,
  });
  setLatestFollowupInterpretation(args.requestScope, followupContext);

  const sections: PiContextSection[] = [
    ...buildCurrentInputSection(args.containerInput),
    ...buildHistorySections(args.containerInput),
  ];
  const followupSection = buildFollowupSection(followupContext);
  if (followupSection) sections.push(followupSection);

  const [memorySection, historyStoreSection, knowledgeSections] =
    await Promise.all([
      buildMemorySection({
        input: args.containerInput,
        runtime: args.runtime,
      }),
      buildHistoryStoreSection({
        input: args.containerInput,
        runtime: args.runtime,
      }),
      buildKnowledgeSections({
        userId: args.userId,
        runtime: args.runtime,
      }),
    ]);
  if (memorySection) sections.push(memorySection);
  if (historyStoreSection) sections.push(historyStoreSection);
  sections.push(...knowledgeSections);

  const compacted = compactSections({
    sections,
    budgetChars: estimatePromptBudgetChars(args.containerInput),
  });
  const provenanceSection = buildProvenanceSection(compacted.provenance);
  const finalSections = [provenanceSection, ...compacted.sections];
  const renderedContext = renderPrompt(finalSections);

  traceEvent({
    type: 'pi_context_loaded',
    totalSections: sections.length,
    retainedSections: compacted.sections.length,
    omittedSections: sections.length - compacted.sections.length,
    promptBytes: byteLength(renderedContext),
    contextBytes: byteLength(renderedContext),
    provenance: compacted.provenance,
  }, args.requestScope);

  return {
    prompt: renderedContext,
    followupContext,
    persistedSkillContext: buildPersistedSkillContext({
      containerInput: args.containerInput,
      followupContext,
    }),
    provenance: compacted.provenance,
  };
}

export function mergePiPersistedSkillContext(args: {
  persistedSkillContext: SkillContextEntry[];
  runtimeSkillContext: SkillContextEntry[];
}): SkillContextEntry[] {
  const hasInterpretation = args.runtimeSkillContext.some(
    (entry) => entry.skill === 'xuanxue-jiedu',
  );
  const merged = hasInterpretation
    ? [...args.persistedSkillContext, ...args.runtimeSkillContext]
    : args.runtimeSkillContext;
  const deduped: SkillContextEntry[] = [];
  for (const entry of merged) {
    const exists = deduped.some(
      (item) => item.skill === entry.skill && item.output === entry.output,
    );
    if (!exists) deduped.push(entry);
  }
  return deduped;
}
