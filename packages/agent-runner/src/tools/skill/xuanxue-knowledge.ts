/**
 * 玄学解读的用户知识处理纯函数：
 * - 把 user skill content 按 ## / ### 章节切分
 * - 按 usage_mode 分桶：force_injected（全文注入）与 queryable（目录注入，模型按需查询）
 * - 知识工具（list_knowledge_sections / read_knowledge_section）的 schema 与执行器
 * - system prompt 格式化 helper
 *
 * 本模块不做任何 IO，便于单测。
 * 不做关键词路由——知识选择权由主 loop 的解读 specialist 决定。
 */

import type { ToolDefinition } from '../../types.js';
import { XUANXUE_SECTION_MAX_BYTES } from '../../constants.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface KnowledgeSection {
  /** ## / ### 后的标题文本；无章节内容时为 "(全文)"；preamble 为 "(前言)"。 */
  title: string;
  /** 到下一个同级或更高层级标题之前的全部内容。 */
  body: string;
  /** 0 = preamble/全文兜底；2 = ##；3 = ###。 */
  level: number;
  /** body 前 120 字，去 markdown 装饰，用于目录与 list_knowledge_sections 返回。 */
  summary: string;
}

export interface KnowledgeSkillBundle {
  skill_dir: string;
  skill_name: string;
  usage_mode: 'force_injected' | 'reference_only';
  category: string;
  category_normalized?: string | null;
  description?: string;
  trigger_hint?: string;
  match_keywords?: string[];
  match_patterns?: string[];
  example_queries?: string[];
  priority?: number;
  source?: 'self' | 'subscribed';
  sections: KnowledgeSection[];
  originalBytes?: number;
  injectedBytes?: number;
  truncated?: boolean;
  omittedSectionTitles?: string[];
  relevanceScore?: number;
  matchedFacets?: string[];
}

export interface RuntimeKnowledgeSkill {
  dir: string;
  name: string;
  description: string;
  trigger: string;
  content: string;
  category: string;
  category_normalized: string | null;
  match_keywords: string[];
  match_patterns: string[];
  example_queries: string[];
  priority: number;
  usage_mode: 'force_injected' | 'reference_only';
  source: 'self' | 'subscribed';
}

export interface PartitionResult {
  /** force_injected：正文全部注入 system prompt。 */
  forceInjected: KnowledgeSkillBundle[];
  /** reference_only 命中 category / 通用类：只把目录注入，供 Gemini 按需查询。 */
  queryable: KnowledgeSkillBundle[];
}

export interface RoutingMatchedUserSkill {
  skillDir: string;
  usageMode: 'force_injected' | 'reference_only';
  skillName?: string;
  category?: string;
  priority?: number;
  reasonCodes?: string[];
}

export interface RoutingPartitionContext {
  routingVersion?: number;
  interpretationForceInjectedSkillDirs?: string[];
  interpretationQueryableSkillDirs?: string[];
  strictQueryableSelection?: boolean;
  matchedUserSkills?: RoutingMatchedUserSkill[];
  normalizedCategory?: string | null;
  intentType?: string;
  requestKind?: string;
  evidenceMode?: string;
  contentSource?: string;
  nextAction?: string;
  requiredOfficialSkill?: string | null;
  mustProduceOfficialResult?: boolean;
  hasUserSuppliedEvidence?: boolean;
  followupStrategy?: string;
  missingRequiredInputs?: string[];
  conversationSkillsToLoad?: string[];
  mustLoadUserSkillsFirst?: boolean;
  shouldPreferInterpretXuanxue?: boolean;
  shouldBlockGenericInterpretWithoutSkill?: boolean;
  understanding?: {
    goalType?: string;
    questionFacets?: string[];
    referenceTarget?: string;
    activeHistorySkill?: string | null;
    confidence?: number;
  };
  executionPlan?: {
    policyMode?: string;
    stages?: Array<{
      name: string;
      purpose: string;
      allowedCapabilityKinds: string[];
    }>;
  };
  debug?: Record<string, unknown>;
}

export interface KnowledgePlanResult extends PartitionResult {
  topicFacets: string[];
  actionFacets: string[];
  questionFacets: string[];
}

// ---------------------------------------------------------------------------
// 章节切分
// ---------------------------------------------------------------------------

const SUMMARY_MAX_CHARS = 120;

/**
 * 把 user skill content 按 ## / ### 切分为章节。
 * - 第一个 ## 之前的内容作为 preamble（title="(前言)"，level=0），空则跳过
 * - 没有任何 ## / ### → 整篇作为单个 section（title="(全文)"，level=0）
 * - 空内容 → 返回空数组
 */
export function splitUserSkillIntoSections(
  content: string,
): KnowledgeSection[] {
  if (!content || !content.trim()) return [];

  const lines = content.split(/\r?\n/);
  const sections: KnowledgeSection[] = [];

  let currentTitle: string | null = null;
  let currentLevel = 0;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (currentTitle === null) {
      // preamble — 只有非空才保留
      if (body) {
        sections.push({
          title: '(前言)',
          body,
          level: 0,
          summary: makeSummary(body),
        });
      }
    } else {
      sections.push({
        title: currentTitle,
        body,
        level: currentLevel,
        summary: makeSummary(body),
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      currentTitle = match[2].trim();
      currentLevel = match[1].length;
      continue;
    }
    buffer.push(line);
  }
  flush();

  // 如果整篇都没有 ##，currentTitle 始终为 null，已作为 preamble 推入
  // 此时把它的 title 改成 "(全文)"，语义更准确
  if (
    sections.length === 1 &&
    sections[0].title === '(前言)' &&
    !/^#{2,3}\s+/m.test(content)
  ) {
    sections[0] = { ...sections[0], title: '(全文)' };
  }

  return sections;
}

/** 去掉常见 markdown 装饰，截取前 N 字作为摘要。 */
function makeSummary(body: string): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, ' ') // 去代码块
    .replace(/`([^`]*)`/g, '$1') // 去行内 code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 去粗体
    .replace(/\*([^*]+)\*/g, '$1') // 去斜体
    .replace(/^#{1,6}\s+/gm, '') // 去标题 #
    .replace(/^>\s?/gm, '') // 去引用
    .replace(/[*_`>#]/g, '') // 残留装饰
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= SUMMARY_MAX_CHARS) return cleaned;
  return cleaned.slice(0, SUMMARY_MAX_CHARS) + '…';
}

// ---------------------------------------------------------------------------
// Skill 分桶
// ---------------------------------------------------------------------------

function toUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function toBundle(skill: RuntimeKnowledgeSkill): KnowledgeSkillBundle {
  return {
    skill_dir: skill.dir,
    skill_name: skill.name,
    usage_mode: skill.usage_mode,
    category: skill.category || '通用',
    category_normalized: skill.category_normalized,
    description: skill.description || '',
    trigger_hint: skill.trigger || '',
    match_keywords: skill.match_keywords || [],
    match_patterns: skill.match_patterns || [],
    example_queries: skill.example_queries || [],
    priority: skill.priority || 0,
    source: skill.source,
    sections: splitUserSkillIntoSections(skill.content || ''),
    originalBytes: toUtf8Bytes(skill.content || ''),
  };
}

/**
 * 把 user skill 分为两桶：
 * - forceInjected：force_injected 且命中 category 或属于"通用"类（全文预注入）
 * - queryable：reference_only 且命中 category 或属于"通用"类（只注入目录）
 */
export function partitionUserSkills(
  userSkills: RuntimeKnowledgeSkill[],
  _routing: RoutingPartitionContext | null,
  argCategory: string | undefined,
): PartitionResult {
  const forceInjected: KnowledgeSkillBundle[] = [];
  const queryable: KnowledgeSkillBundle[] = [];

  for (const skill of userSkills) {
    if (!skill.content?.trim()) continue;
    if (!skillCategoryMatches(skill, argCategory)) continue;

    if (skill.usage_mode === 'force_injected') {
      forceInjected.push(toBundle(skill));
    } else {
      queryable.push(toBundle(skill));
    }
  }

  return { forceInjected, queryable };
}

function skillCategoryMatches(
  skill: RuntimeKnowledgeSkill,
  argCategory: string | undefined,
): boolean {
  const normalizedSkillCategory =
    skill.category_normalized?.trim() || skill.category?.trim() || '通用';
  if (normalizedSkillCategory === '通用') return true;

  const requestedCategory = argCategory?.trim();
  if (!requestedCategory) return true;

  return (
    normalizedSkillCategory === requestedCategory ||
    skill.category?.trim() === requestedCategory
  );
}

/**
 * 简化版：不做关键词打分或 budget 裁剪。
 * forceInjected 保持不变，queryable 保持不变。
 * 知识库的选择权完全交给子 loop 的 Gemini。
 */
export function planKnowledgeContext(
  buckets: PartitionResult,
): KnowledgePlanResult {
  return {
    forceInjected: buckets.forceInjected,
    queryable: buckets.queryable,
    topicFacets: [],
    actionFacets: [],
    questionFacets: [],
  };
}

// ---------------------------------------------------------------------------
// 子 loop 工具 schema
// ---------------------------------------------------------------------------

export const LIST_SECTIONS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_knowledge_sections',
    description:
      '列出用户知识库中可查询的章节目录。初始 system prompt 已包含一份，仅在需要复查时调用。可选按 skill_dir 过滤。',
    parameters: {
      type: 'object',
      properties: {
        skill_dir: {
          type: 'string',
          description: '可选：只列出指定 skill_dir 的章节',
        },
      },
    },
  },
};

export const READ_SECTION_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_knowledge_section',
    description:
      '读取用户知识库中某章节的完整正文。必须传 skill_dir 和 section_title（来自 list_knowledge_sections 或 system prompt 中的目录）。',
    parameters: {
      type: 'object',
      properties: {
        skill_dir: {
          type: 'string',
          description: 'skill 目录名',
        },
        section_title: {
          type: 'string',
          description: '章节标题（必须精确匹配目录中的 title）',
        },
      },
      required: ['skill_dir', 'section_title'],
    },
  },
};

export const FINAL_ANSWER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'final_answer',
    description: '完成玄学解读后调用此工具返回最终解读正文。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '完整的解读正文（自然语言）',
        },
      },
      required: ['text'],
    },
  },
};

export const KNOWLEDGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  LIST_SECTIONS_TOOL,
  READ_SECTION_TOOL,
  FINAL_ANSWER_TOOL,
];

// ---------------------------------------------------------------------------
// 工具执行（纯内存，无 IO）
// ---------------------------------------------------------------------------

export interface KnowledgeToolResult {
  output: string;
  isError?: boolean;
}

/**
 * 执行子 loop 发起的知识工具调用。纯函数，不访问 DB / FS。
 */
export function executeKnowledgeTool(
  toolName: string,
  args: Record<string, unknown>,
  bundles: KnowledgeSkillBundle[],
): KnowledgeToolResult {
  if (toolName === 'list_knowledge_sections') {
    return execListSections(args, bundles);
  }
  if (toolName === 'read_knowledge_section') {
    return execReadSection(args, bundles);
  }
  if (toolName === 'final_answer') {
    return execFinalAnswer(args);
  }
  return {
    output: `未知工具: ${toolName}`,
    isError: true,
  };
}

function execFinalAnswer(args: Record<string, unknown>): KnowledgeToolResult {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) {
    return {
      output: 'final_answer.text 不能为空',
      isError: true,
    };
  }
  return { output: text };
}

function execListSections(
  args: Record<string, unknown>,
  bundles: KnowledgeSkillBundle[],
): KnowledgeToolResult {
  const filterDir =
    typeof args.skill_dir === 'string' ? args.skill_dir : undefined;
  const items: Array<{
    skill_dir: string;
    skill_name: string;
    section_title: string;
    summary: string;
  }> = [];
  for (const b of bundles) {
    if (filterDir && b.skill_dir !== filterDir) continue;
    for (const s of b.sections) {
      items.push({
        skill_dir: b.skill_dir,
        skill_name: b.skill_name,
        section_title: s.title,
        summary: s.summary,
      });
    }
  }
  if (items.length === 0) {
    const availableDirs = bundles.map((b) => b.skill_dir);
    return {
      output: JSON.stringify({
        sections: [],
        note:
          filterDir && !availableDirs.includes(filterDir)
            ? `skill_dir "${filterDir}" 不存在，可用: ${availableDirs.join(', ') || '(无)'}`
            : '没有可查询的章节',
      }),
    };
  }
  return {
    output: JSON.stringify({ sections: items }),
  };
}

function execReadSection(
  args: Record<string, unknown>,
  bundles: KnowledgeSkillBundle[],
): KnowledgeToolResult {
  const skillDir = typeof args.skill_dir === 'string' ? args.skill_dir : '';
  const sectionTitle =
    typeof args.section_title === 'string' ? args.section_title : '';
  if (!skillDir || !sectionTitle) {
    return {
      output: JSON.stringify({
        error: '缺少参数 skill_dir 或 section_title',
      }),
      isError: true,
    };
  }

  const bundle = bundles.find((b) => b.skill_dir === skillDir);
  if (!bundle) {
    return {
      output: JSON.stringify({
        error: `skill "${skillDir}" 未找到`,
        availableSkills: bundles.map((b) => b.skill_dir),
      }),
      isError: true,
    };
  }

  const section = bundle.sections.find((s) => s.title === sectionTitle);
  if (!section) {
    return {
      output: JSON.stringify({
        error: `章节 "${sectionTitle}" 在 skill "${skillDir}" 中不存在`,
        availableSections: bundle.sections.map((s) => s.title),
      }),
      isError: true,
    };
  }

  const byteLen = Buffer.byteLength(section.body, 'utf8');
  if (byteLen > XUANXUE_SECTION_MAX_BYTES) {
    // 粗略按字符截断（UTF-8 多字节可能略超/略欠 XUANXUE_SECTION_MAX_BYTES，不精确但够用）
    const ratio = XUANXUE_SECTION_MAX_BYTES / byteLen;
    const cutChars = Math.floor(section.body.length * ratio);
    return {
      output: JSON.stringify({
        skill_dir: bundle.skill_dir,
        skill_name: bundle.skill_name,
        section_title: section.title,
        body: section.body.slice(0, cutChars),
        truncated: true,
        original_size: byteLen,
      }),
    };
  }

  return {
    output: JSON.stringify({
      skill_dir: bundle.skill_dir,
      skill_name: bundle.skill_name,
      section_title: section.title,
      body: section.body,
      size: byteLen,
    }),
  };
}

// ---------------------------------------------------------------------------
// System prompt 格式化
// ---------------------------------------------------------------------------

function buildOmittedSectionNote(sectionTitles: string[]): string {
  if (sectionTitles.length === 0) return '';
  const preview = sectionTitles.slice(0, 4).join('、');
  const suffix =
    sectionTitles.length > 4 ? ` 等 ${sectionTitles.length} 章` : '';
  return `【未展开章节】\n${preview}${suffix}\n如需细节，请通过知识工具读取对应章节。`;
}

/**
 * 强规则 skill 正文拼接为 system prompt 段。空数组返回空字符串。
 */
export function formatForceInjected(bundles: KnowledgeSkillBundle[]): string {
  if (bundles.length === 0) return '';
  const blocks = bundles.map((b) => {
    const body = b.sections
      .map((s) =>
        s.title.startsWith('(') ? s.body : `### ${s.title}\n${s.body}`,
      )
      .join('\n\n');
    const omittedNote = buildOmittedSectionNote(b.omittedSectionTitles || []);
    return `【${b.skill_name}】\n${[body, omittedNote].filter(Boolean).join('\n\n')}`;
  });
  return (
    '=== 必读参考资料（以下内容必须在解读中体现） ===\n' +
    blocks.join('\n\n') +
    '\n=== 必读参考资料结束 ==='
  );
}

/**
 * 弱规则 skill 章节目录拼接为 system prompt 段。空数组返回空字符串。
 */
export function formatSectionIndex(bundles: KnowledgeSkillBundle[]): string {
  if (bundles.length === 0) return '';
  const lines: string[] = [
    '=== 可查知识库章节（按需调用 read_knowledge_section 读取） ===',
  ];
  for (const b of bundles) {
    lines.push(`\n【${b.skill_name}】 skill_dir=${b.skill_dir}`);
    const metadata = formatKnowledgeMetadata(b);
    if (metadata) lines.push(`  ${metadata}`);
    for (const s of b.sections) {
      const summary = s.summary ? ` — ${s.summary}` : '';
      lines.push(`  - title="${s.title}"${summary}`);
    }
  }
  lines.push('=== 章节目录结束 ===');
  return lines.join('\n');
}

function formatKnowledgeMetadata(bundle: KnowledgeSkillBundle): string {
  const parts: string[] = [];
  if (bundle.category) {
    parts.push(`category=${formatMetadataValue(bundle.category)}`);
  }
  if (bundle.description) {
    parts.push(`description=${formatMetadataValue(bundle.description)}`);
  }
  if (bundle.trigger_hint) {
    parts.push(`trigger=${formatMetadataValue(bundle.trigger_hint)}`);
  }
  if (bundle.match_keywords?.length) {
    parts.push(`keywords=${formatMetadataValue(bundle.match_keywords.join('、'))}`);
  }
  if (bundle.example_queries?.length) {
    parts.push(`examples=${formatMetadataValue(bundle.example_queries.join('；'))}`);
  }
  return parts.length ? `metadata: ${parts.join(' ')}` : '';
}

function formatMetadataValue(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}
