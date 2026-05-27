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
  SkillContextEntry,
} from '../types.js';
import type { RequestRuntime } from '../runtime.js';

const PROMPT_BUDGET_RATIO = 0.5;
const MIN_CONTEXT_BUDGET_CHARS = 16_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const APPROX_CHARS_PER_TOKEN = 4;
const TOOL_CONTEXT_PREVIEW_CHARS = 4_000;
const MEMORY_PREVIEW_CHARS = 2_000;

type ProvenanceSource =
  | 'request'
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

function resolveCurrentEvidenceCategory(
  input: ContainerInput,
): string | undefined {
  if (input.pastedBoard?.category) return input.pastedBoard.category;
  if (input.activeBoardContext) {
    return resolveEvidenceCategoryBySkill(input.activeBoardContext.skill) ??
      undefined;
  }
  return undefined;
}

async function resolveLatestFollowupInterpretationContext(args: {
  containerInput: ContainerInput;
  runtime: RequestRuntime;
  requestScope: RequestScope;
}): Promise<FollowupInterpretationContext | null> {
  const category = resolveCurrentEvidenceCategory(args.containerInput);
  try {
    const fromDb =
      await args.runtime.deps.workflowContextStore?.latestFollowupContext({
        accountId: args.containerInput.accountId,
        category,
        sessionId: args.containerInput.sessionId,
      });
    if (fromDb) {
      traceEvent({
        type: 'pi_context_followup_loaded',
        source: 'database',
        category: fromDb.category,
        hasBoard: Boolean(fromDb.boardSkill),
        hasInterpretation: Boolean(fromDb.interpretationOutput),
      }, args.requestScope);
    }
    return fromDb ?? null;
  } catch (error) {
    log(
      `pi context followup db fallback failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
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

function buildFollowupSection(
  context: FollowupInterpretationContext | null,
): PiContextSection | null {
  if (!context) return null;
  return createSection({
    id: 'followup_context',
    title: '业务 artifact 连续性上下文',
    source: 'database',
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
              '策略：这里只注入长期记忆摘要；不要调用旧 memory tool 修改或读取全文。',
            ].join('\n')
          : [
              content,
              '策略：当前长期记忆已完整注入；用户知识/记忆管理由 Pi session 与 API 控制面负责。',
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
    '真实用户输入会作为 Pi user prompt 直接发送；请基于上述 Pi context、<available_skills> 中的 Markdown Skill 以及按需读取到的 Skill 正文判断缺失信息、是否追问和最终回复。不要要求外部 request boundary 替你决定上下文连续性。',
  ].join('\n');
}

export async function createPiSessionContext(args: {
  containerInput: ContainerInput;
  runtime: RequestRuntime;
  requestScope: RequestScope;
}): Promise<PiSessionContext> {
  const followupContext = await resolveLatestFollowupInterpretationContext({
    containerInput: args.containerInput,
    runtime: args.runtime,
    requestScope: args.requestScope,
  });
  setLatestFollowupInterpretation(args.requestScope, followupContext);

  const sections: PiContextSection[] = [
    ...buildCurrentInputSection(args.containerInput),
  ];
  const followupSection = buildFollowupSection(followupContext);
  if (followupSection) sections.push(followupSection);

  const memorySection = await buildMemorySection({
    input: args.containerInput,
    runtime: args.runtime,
  });
  if (memorySection) sections.push(memorySection);

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
  const merged = [...args.persistedSkillContext, ...args.runtimeSkillContext];
  const deduped: SkillContextEntry[] = [];
  for (const entry of merged) {
    const exists = deduped.some(
      (item) => item.skill === entry.skill && item.output === entry.output,
    );
    if (!exists) deduped.push(entry);
  }
  return deduped;
}
