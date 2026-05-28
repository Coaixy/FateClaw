'use client';

import { useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Flag,
  HelpCircle,
  Play,
  Repeat,
  Route,
  Sparkles,
  TrendingDown,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { TraceEventEntry } from '@/lib/admin-api';

import { formatTraceTime } from './log-utils';

type TraceCategory =
  | 'summary'
  | 'iteration'
  | 'orchestration'
  | 'tool'
  | 'error';

const TRACE_EVENT_META: Record<
  string,
  {
    icon: LucideIcon;
    colorClass: string;
    label: string;
    category: TraceCategory;
  }
> = {
  request_start: {
    icon: Play,
    colorClass: 'text-green-400',
    label: '请求开始',
    category: 'summary',
  },
  agent_kernel_started: {
    icon: Route,
    colorClass: 'text-cyan-400',
    label: 'Agent Kernel 开始',
    category: 'orchestration',
  },
  agent_kernel_completed: {
    icon: CheckCircle2,
    colorClass: 'text-emerald-400',
    label: 'Agent Kernel 完成',
    category: 'summary',
  },
  specialist_started: {
    icon: Bot,
    colorClass: 'text-blue-300',
    label: 'Specialist 开始',
    category: 'orchestration',
  },
  specialist_prompt_prepared: {
    icon: FileText,
    colorClass: 'text-blue-200',
    label: 'Specialist Prompt',
    category: 'orchestration',
  },
  specialist_completed: {
    icon: CheckCircle2,
    colorClass: 'text-emerald-300',
    label: 'Specialist 完成',
    category: 'summary',
  },
  specialist_failed: {
    icon: AlertTriangle,
    colorClass: 'text-red-400',
    label: 'Specialist 失败',
    category: 'error',
  },
  assistant_reply: {
    icon: CheckCircle2,
    colorClass: 'text-green-400',
    label: '最终回复',
    category: 'summary',
  },
  loop_iteration: {
    icon: Repeat,
    colorClass: 'text-sky-400',
    label: '主 loop 轮次',
    category: 'iteration',
  },
  ai_orchestration: {
    icon: Route,
    colorClass: 'text-cyan-400',
    label: 'AI 编排',
    category: 'orchestration',
  },
  tool_call: {
    icon: Wrench,
    colorClass: 'text-amber-400',
    label: '工具调用',
    category: 'tool',
  },
  tool_result: {
    icon: CheckCircle2,
    colorClass: 'text-amber-300',
    label: '工具结果',
    category: 'tool',
  },
  tool_error: {
    icon: AlertTriangle,
    colorClass: 'text-red-400',
    label: '工具异常',
    category: 'error',
  },
  context_trimmed: {
    icon: TrendingDown,
    colorClass: 'text-orange-400',
    label: '上下文截断',
    category: 'error',
  },
  context_too_long: {
    icon: AlertTriangle,
    colorClass: 'text-orange-400',
    label: '上下文过长',
    category: 'error',
  },
  rate_limit: {
    icon: AlertTriangle,
    colorClass: 'text-red-400',
    label: '限流 429',
    category: 'error',
  },
  truncated_tool_calls_fallback: {
    icon: AlertTriangle,
    colorClass: 'text-orange-400',
    label: '工具调用被截断',
    category: 'error',
  },
  protocol_violation: {
    icon: AlertTriangle,
    colorClass: 'text-orange-400',
    label: '协议违例',
    category: 'error',
  },
  trace_overflow: {
    icon: Flag,
    colorClass: 'text-yellow-400',
    label: 'Trace 截断',
    category: 'error',
  },
  pi_session_snapshot: {
    icon: FileText,
    colorClass: 'text-cyan-300',
    label: 'Pi Session',
    category: 'summary',
  },
};

const TRACE_HIDDEN_FIELDS = new Set([
  'type',
  'timestamp',
  'requestId',
  'accountId',
]);

function fieldText(event: TraceEventEntry, key: string): string {
  const value = event[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function fieldStringList(event: TraceEventEntry, key: string): string[] {
  const value = event[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function fieldTextChunks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function fieldRecordList(
  event: TraceEventEntry,
  key: string,
): Array<Record<string, unknown>> {
  const value = event[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function recordStringList(
  record: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordValueText(
  record: Record<string, unknown> | null,
  key: string,
): string {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function shortPreview(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function TraceDetailCard({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'blue' | 'purple' | 'emerald' | 'amber' | 'red';
}) {
  const toneClass =
    tone === 'blue'
      ? 'border-blue-500/20 bg-blue-500/5'
      : tone === 'purple'
        ? 'border-purple-500/20 bg-purple-500/5'
        : tone === 'emerald'
          ? 'border-emerald-500/20 bg-emerald-500/5'
          : tone === 'amber'
            ? 'border-amber-500/20 bg-amber-500/5'
            : tone === 'red'
              ? 'border-red-500/20 bg-red-500/5'
              : 'border-hairline bg-canvas/50';

  return (
    <div className={`mt-2 rounded-lg border p-3 ${toneClass}`}>
      {children}
    </div>
  );
}

function CollapsibleTraceText({
  label,
  text,
  tone = 'neutral',
  defaultExpanded = false,
}: {
  label: string;
  text: string;
  tone?: 'neutral' | 'blue' | 'purple' | 'emerald' | 'amber' | 'red';
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isLong = text.length > 360 || text.split('\n').length > 8;
  const toneClass =
    tone === 'blue'
      ? 'border-blue-500/20 bg-blue-500/5'
      : tone === 'purple'
        ? 'border-purple-500/20 bg-purple-500/5'
        : tone === 'emerald'
          ? 'border-emerald-500/20 bg-emerald-500/5'
          : tone === 'amber'
            ? 'border-amber-500/20 bg-amber-500/5'
            : tone === 'red'
              ? 'border-red-500/20 bg-red-500/5'
              : 'border-hairline bg-canvas';
  const displayText = expanded || !isLong ? text : shortPreview(text);

  return (
    <div className={`rounded-md border px-2.5 py-2 ${toneClass}`}>
      <button
        type="button"
        onClick={() => isLong && setExpanded((value) => !value)}
        className={`flex w-full items-center gap-1.5 text-left ${
          isLong ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
        }`}
      >
        <span className="text-[10px] uppercase tracking-wider text-muted">
          {label}
        </span>
        <span className="font-mono text-[10px] text-muted">
          {text.length} chars
        </span>
        {isLong && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {expanded ? '收起' : '展开'}
          </span>
        )}
      </button>
      <pre
        className={`mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink ${
          expanded ? 'max-h-[36rem] overflow-y-auto' : ''
        }`}
      >
        {displayText}
      </pre>
    </div>
  );
}

function PromptMessagesBlock({
  messages,
}: {
  messages: Array<Record<string, unknown>>;
}) {
  if (messages.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {messages.map((message, index) => {
        const role =
          typeof message.role === 'string'
            ? message.role
            : `message-${index + 1}`;
        const content =
          fieldTextChunks(message.contentChunks).join('') ||
          (typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content ?? '', null, 2));
        return (
          <CollapsibleTraceText
            key={`${role}:${index}`}
            label={`runtime ${role}`}
            text={content}
            tone={role === 'system' ? 'blue' : 'neutral'}
          />
        );
      })}
    </div>
  );
}

function TraceMetricChips({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  const visibleItems = items.filter((item) => item.value);
  if (visibleItems.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleItems.map((item) => (
        <span
          key={`${item.label}:${item.value}`}
          className="rounded bg-canvas px-1.5 py-0.5 text-[10px] text-muted"
        >
          {item.label}={item.value}
        </span>
      ))}
    </div>
  );
}

function ReadableTraceDetail({
  event,
}: {
  event: TraceEventEntry;
}) {
  if (event.type === 'request_start') {
    const promptPreview = fieldText(event, 'promptPreview');
    return (
      <TraceDetailCard tone="emerald">
        <TraceMetricChips
          items={[
            { label: 'provider', value: fieldText(event, 'provider') },
            { label: 'model', value: fieldText(event, 'model') },
            { label: 'history', value: fieldText(event, 'historyCount') },
          ]}
        />
        {promptPreview && (
          <div className="mt-2">
            <CollapsibleTraceText
              label="请求 prompt"
              text={promptPreview}
              tone="emerald"
            />
          </div>
        )}
      </TraceDetailCard>
    );
  }

  if (event.type === 'specialist_started') {
    return (
      <TraceDetailCard tone="blue">
        <TraceMetricChips
          items={[
            { label: 'specialist', value: fieldText(event, 'specialist') },
          ]}
        />
      </TraceDetailCard>
    );
  }

  if (event.type === 'specialist_prompt_prepared') {
    const runtimePromptMessages = fieldRecordList(event, 'runtimePromptMessages');
    return (
      <TraceDetailCard tone="blue">
        <TraceMetricChips
          items={[
            { label: 'specialist', value: fieldText(event, 'specialist') },
            { label: 'history', value: fieldText(event, 'historyCount') },
          ]}
        />
        <PromptMessagesBlock messages={runtimePromptMessages} />
        {runtimePromptMessages.length === 0 && fieldText(event, 'systemPrompt') && (
          <div className="mt-2">
            <CollapsibleTraceText
              label="runtime system"
              text={fieldText(event, 'systemPrompt')}
              tone="blue"
            />
          </div>
        )}
        {runtimePromptMessages.length === 0 &&
          fieldText(event, 'delegationMessage') && (
            <div className="mt-2">
              <CollapsibleTraceText
                label="runtime user"
                text={fieldText(event, 'delegationMessage')}
              />
            </div>
          )}
      </TraceDetailCard>
    );
  }

  if (event.type === 'specialist_completed') {
    return (
      <TraceDetailCard tone="emerald">
        <TraceMetricChips
          items={[
            { label: 'specialist', value: fieldText(event, 'specialist') },
            { label: 'text', value: fieldText(event, 'textLength') },
            { label: 'skills', value: fieldText(event, 'skillCount') },
            { label: 'artifacts', value: fieldText(event, 'newArtifactCount') },
          ]}
        />
      </TraceDetailCard>
    );
  }

  if (event.type === 'specialist_failed') {
    return (
      <TraceDetailCard tone="red">
        <TraceMetricChips
          items={[
            { label: 'specialist', value: fieldText(event, 'specialist') },
          ]}
        />
        <pre className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-red-200">
          {fieldText(event, 'failureReason')}
        </pre>
      </TraceDetailCard>
    );
  }

  if (event.type === 'agent_kernel_completed') {
    return (
      <TraceDetailCard tone="emerald">
        <TraceMetricChips
          items={[
            { label: 'text', value: fieldText(event, 'textLength') },
            { label: 'skillContext', value: fieldText(event, 'totalSkillContext') },
            { label: 'fastPath', value: fieldText(event, 'fastPath') },
          ]}
        />
      </TraceDetailCard>
    );
  }

  if (event.type === 'pi_session_snapshot') {
    const session = isRecord(event.session) ? event.session : null;
    const appendSystemPrompt = recordStringList(session, 'appendSystemPrompt');
    const allowedTools = recordStringList(session, 'allowedTools');
    return (
      <TraceDetailCard tone="blue">
        <TraceMetricChips
          items={[
            { label: 'id', value: recordValueText(session, 'id') },
            { label: 'provider', value: recordValueText(session, 'provider') },
            { label: 'model', value: recordValueText(session, 'model') },
            { label: 'persisted', value: recordValueText(session, 'persisted') },
            { label: 'messages', value: recordValueText(session, 'messageCount') },
            { label: 'tools', value: String(allowedTools.length) },
          ]}
        />
        {recordValueText(session, 'file') && (
          <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[11px] text-muted">
            {recordValueText(session, 'file')}
          </pre>
        )}
        {recordValueText(session, 'systemPrompt') && (
          <div className="mt-2">
            <CollapsibleTraceText
              label="system prompt"
              text={recordValueText(session, 'systemPrompt')}
              tone="blue"
              defaultExpanded
            />
          </div>
        )}
        {appendSystemPrompt.map((prompt, index) => (
          <div className="mt-2" key={`append-system-${index}`}>
            <CollapsibleTraceText
              label={`append system #${index + 1}`}
              text={prompt}
              tone="purple"
            />
          </div>
        ))}
        {recordValueText(session, 'userPrompt') && (
          <div className="mt-2">
            <CollapsibleTraceText
              label="user prompt"
              text={recordValueText(session, 'userPrompt')}
            />
          </div>
        )}
      </TraceDetailCard>
    );
  }

  if (event.type === 'tool_result') {
    const modelOutputPreview = fieldText(event, 'modelOutputPreview');
    if (!modelOutputPreview) return null;
    return (
      <TraceDetailCard tone="amber">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Sparkles size={11} className="text-amber-300" />
          <span className="font-medium text-amber-200">
            模型可见输出 / formatter preview
          </span>
          <span className="font-mono text-muted">
            {fieldText(event, 'modelOutputBytes')} bytes
          </span>
        </div>
        <div className="mt-2">
          <CollapsibleTraceText
            label="模型可见输出"
            text={modelOutputPreview}
            tone="amber"
          />
        </div>
      </TraceDetailCard>
    );
  }

  return null;
}

function TraceEventRow({
  event,
}: {
  event: TraceEventEntry;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const meta = TRACE_EVENT_META[event.type] ?? {
    icon: HelpCircle,
    colorClass: 'text-muted',
    label: event.type || '未知事件',
    category: 'orchestration' as TraceCategory,
  };
  const Icon = meta.icon;
  const payloadEntries = Object.entries(event).filter(
    ([k]) => !TRACE_HIDDEN_FIELDS.has(k),
  );
  const hasPayload = payloadEntries.length > 0;
  const inlinePreview = buildInlinePreview(event);

  return (
    <div className="py-1">
      <button
        onClick={() => hasPayload && setExpanded(!expanded)}
        className={`w-full flex items-center gap-1.5 text-[12px] text-left ${
          hasPayload ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
        }`}
      >
        <span className="text-[10px] font-mono text-muted w-[68px] shrink-0">
          {formatTraceTime(event.timestamp)}
        </span>
        <Icon size={12} className={`${meta.colorClass} shrink-0`} />
        <span className={`${meta.colorClass} font-medium shrink-0`}>
          {meta.label}
        </span>
        {inlinePreview && (
          <span className="text-muted truncate font-mono text-[11px]">
            {inlinePreview}
          </span>
        )}
        {hasPayload && (
          <ChevronRight
            size={10}
            className={`text-muted shrink-0 ml-auto transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        )}
      </button>
      {expanded && hasPayload && (
        <div className="ml-[80px]">
          <ReadableTraceDetail event={event} />
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setRawExpanded((value) => !value)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink cursor-pointer"
            >
              {rawExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              原始 JSON
            </button>
            {rawExpanded && (
              <pre className="mt-1 text-[11px] text-muted bg-canvas rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto border border-hairline">
                {JSON.stringify(
                  Object.fromEntries(payloadEntries),
                  null,
                  2,
                )}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function buildInlinePreview(event: TraceEventEntry): string {
  const preview = (value: string, maxLength = 80): string =>
    value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value;
  const get = (k: string): string | undefined => {
    const v = event[k];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  };
  const pieces: string[] = [];
  const iteration = get('iteration');
  if (iteration) pieces.push(`#${iteration}`);
  const toolName = get('toolName') ?? get('tool');
  if (toolName) pieces.push(toolName);
  const skillDir = get('skillDir');
  if (skillDir) pieces.push(skillDir);
  const specialist = get('specialist');
  if (specialist) pieces.push(specialist);
  const promptPreview = get('promptPreview');
  if (promptPreview) pieces.push(preview(promptPreview, 60));
  if (event.type === 'specialist_completed') {
    const textLength = get('textLength');
    const skillCount = get('skillCount');
    const newArtifactCount = get('newArtifactCount');
    if (textLength) pieces.push(`${textLength}ch`);
    if (skillCount) pieces.push(`skills=${skillCount}`);
    if (newArtifactCount) pieces.push(`artifacts=${newArtifactCount}`);
  }
  if (event.type === 'specialist_prompt_prepared') {
    const historyCount = get('historyCount');
    if (historyCount) pieces.push(`history=${historyCount}`);
    const runtimeMessages = Array.isArray(event.runtimePromptMessages)
      ? event.runtimePromptMessages.length
      : 0;
    if (runtimeMessages) pieces.push(`messages=${runtimeMessages}`);
  }
  if (event.type === 'specialist_failed') {
    const failureReason = get('failureReason');
    if (failureReason) pieces.push(preview(failureReason, 80));
  }
  const sectionTitle = get('sectionTitle');
  if (sectionTitle) pieces.push(`§${sectionTitle}`);
  const ok = get('ok');
  if (ok !== undefined) pieces.push(ok === 'true' ? '✓' : '✗');
  const provider = get('provider');
  const model = get('model');
  if (provider && model) pieces.push(`${provider}/${model}`);
  if (event.type === 'pi_session_snapshot' && isRecord(event.session)) {
    const messageCount = event.session.messageCount;
    if (typeof messageCount === 'number') pieces.push(`${messageCount} messages`);
    const id = event.session.id;
    if (typeof id === 'string') pieces.push(id);
  }
  const modelOutputBytes = get('modelOutputBytes');
  if (modelOutputBytes) pieces.push(`${modelOutputBytes}b`);
  const error = get('error');
  if (error) pieces.push(error.slice(0, 80));
  const reason = get('reason');
  if (reason) pieces.push(reason);
  return pieces.join(' · ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}


export function TraceTimeline({
  events,
}: {
  events: TraceEventEntry[];
}) {
  if (!events || events.length === 0) return null;

  type EventGroup = { separator: TraceEventEntry | null; events: TraceEventEntry[] };
  const groups: EventGroup[] = [];
  let cur: EventGroup = { separator: null, events: [] };
  for (const ev of events) {
    if (ev.type === 'loop_iteration') {
      if (cur.events.length > 0 || cur.separator) groups.push(cur);
      cur = { separator: ev, events: [] };
    } else {
      cur.events.push(ev);
    }
  }
  if (cur.events.length > 0 || cur.separator) groups.push(cur);

  return (
    <div className="mt-2 pt-2 border-t border-hairline">
      <div className="flex items-center gap-1.5 mb-1.5 text-[12px]">
        <Activity size={13} className="text-muted" />
        <span className="text-muted font-medium">
          Trace 事件
        </span>
        <span className="text-muted font-mono text-[11px]">
          ({events.length} 条)
        </span>
      </div>
      <div className="space-y-0">
        {groups.map((group, gi) => (
          <div key={gi}>
            {group.separator && (
              <div className="flex items-center gap-2 my-1.5 select-none">
                <Repeat size={11} className="text-sky-400 shrink-0" />
                <span className="text-[11px] text-sky-400 font-medium shrink-0">
                  Loop #{typeof group.separator.iteration === 'number' ? group.separator.iteration : gi + 1}
                </span>
                <div className="flex-1 border-t border-sky-500/20" />
                <span className="text-[10px] font-mono text-muted">
                  {formatTraceTime(group.separator.timestamp)}
                </span>
              </div>
            )}
            <div className={group.separator ? 'pl-3' : ''}>
              {group.events.map((event, i) => (
                <TraceEventRow key={i} event={event} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
