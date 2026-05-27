'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Package,
  Sparkles,
  Wrench,
  XCircle,
  Bot,
} from 'lucide-react';

import { ConversationLog, TraceEventEntry, TranscriptEvent } from '@/lib/admin-api';

import {
  isRecord,
  safeJsonStringify,
  toText,
  tokenLabel,
} from './log-utils';

export function UsageBreakdown({
  usage,
}: {
  usage: ConversationLog['usage'];
  traceEvents?: TraceEventEntry[] | null | undefined;
}) {
  if (!usage) return null;

  return (
    <div className="mt-2 rounded-lg border border-hairline bg-surface-cream-strong/60 p-3">
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className="text-ink font-medium">Token 拆分</span>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <div className="text-[11px] text-blue-300">总计费用量</div>
          <div className="mt-1 font-mono text-[13px] text-ink">
            {tokenLabel(usage.promptTokens)}↑ / {tokenLabel(usage.completionTokens)}↓
          </div>
        </div>
        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <div className="text-[11px] text-emerald-300">主 loop 总量</div>
          <div className="mt-1 font-mono text-[13px] text-ink">
            {tokenLabel(usage.promptTokens + usage.completionTokens)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function extractFinalOutput(log: ConversationLog): string {
  const finalEvidence = log.agent_graph?.evidence.find(
    (item) => item.source === 'final_reply',
  );
  if (isRecord(finalEvidence?.payload) && typeof finalEvidence.payload.text === 'string') {
    return finalEvidence.payload.text;
  }
  return (
    log.agent_graph?.summary.finalTextPreview ||
    log.agent_graph_summary?.finalTextPreview ||
    ''
  );
}

export function FinalOutputCard({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text.trim()) return null;

  const isLong = text.length > 360 || text.split('\n').length > 8;
  const displayText =
    expanded || !isLong ? text : `${text.slice(0, 360).trimEnd()}...`;

  return (
    <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] p-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
        <span className="text-[12px] font-medium text-emerald-300">
          最终输出
        </span>
        <span className="text-[10px] font-mono text-muted">
          {text.length} 字符
        </span>
        {isLong && (
          <button
            onClick={() => setExpanded((value) => !value)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink cursor-pointer"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
      <pre
        className={`mt-2 whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 text-[12px] leading-relaxed text-ink border border-hairline ${
          expanded ? 'max-h-[36rem] overflow-y-auto' : ''
        }`}
      >
        {displayText}
      </pre>
    </div>
  );
}

export function TranscriptEventView({ event }: { event: TranscriptEvent }) {
  const [expanded, setExpanded] = useState(false);
  const [modelOutputExpanded, setModelOutputExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const ModelOutputChevron = modelOutputExpanded ? ChevronDown : ChevronRight;

  if (event.type === 'assistant') {
    return (
      <div className="flex items-start gap-2 py-1.5">
        <Bot size={14} className="mt-0.5 text-blue-400 shrink-0" />
        <span className="text-[13px] text-ink whitespace-pre-wrap break-all">
          {event.text}
        </span>
      </div>
    );
  }

  if (event.type === 'tool_use' && event.invocation) {
    const argsStr = safeJsonStringify(event.invocation.args);
    const isLong = argsStr.length > 120;
    return (
      <div className="py-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[13px] text-amber-400 hover:text-amber-300 cursor-pointer"
        >
          <Wrench size={14} className="shrink-0" />
          <span className="font-mono font-medium">
            {event.invocation.toolName}
          </span>
          {event.invocation.displayTitle && (
            <span className="text-[12px] text-muted font-normal">
              — {event.invocation.displayTitle}
            </span>
          )}
          {isLong && <Chevron size={12} />}
        </button>
        {(expanded || !isLong) && (
          <pre className="mt-1 ml-5 text-[12px] text-muted bg-canvas rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">
            {argsStr}
          </pre>
        )}
      </div>
    );
  }

  if (event.type === 'tool_result') {
    const output = toText(event.output);
    const modelOutput = toText(event.modelOutput);
    const isLong = output.length > 200;
    const hasModelOutput =
      modelOutput.trim().length > 0 && modelOutput !== output;
    const modelOutputLong = modelOutput.length > 200;
    const StatusIcon = event.ok ? CheckCircle2 : XCircle;
    const statusColor = event.ok ? 'text-green-400' : 'text-red-400';
    return (
      <div className="py-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[13px] cursor-pointer"
        >
          <StatusIcon size={14} className={`shrink-0 ${statusColor}`} />
          <span className="text-muted">
            {event.ok ? '成功' : '失败'} &middot; {output.length} 字符
          </span>
          {event.artifactId && (
            <span className="flex items-center gap-0.5 text-[11px] text-purple-400 font-mono bg-purple-500/10 px-1.5 py-0.5 rounded">
              <Package size={10} />
              {event.artifactId}
            </span>
          )}
          {isLong && (
            <Chevron size={12} className="text-muted" />
          )}
        </button>
        {hasModelOutput && (
          <div className="mt-1 ml-5">
            <button
              onClick={() => setModelOutputExpanded(!modelOutputExpanded)}
              className="flex items-center gap-1.5 text-[12px] text-cyan-300 hover:text-cyan-200 cursor-pointer"
            >
              <Sparkles size={12} className="shrink-0" />
              <span className="font-medium">模型可见输出 / formatter</span>
              <span className="text-muted font-mono">
                {modelOutput.length} 字符
              </span>
              {modelOutputLong && (
                <ModelOutputChevron
                  size={11}
                  className="text-muted"
                />
              )}
            </button>
            {(modelOutputExpanded || !modelOutputLong) && (
              <pre className="mt-1 text-[12px] text-ink bg-cyan-500/5 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto border border-cyan-500/15">
                {modelOutput}
              </pre>
            )}
          </div>
        )}
        {(expanded || !isLong) && (
          <pre className="mt-1 ml-5 text-[12px] text-muted bg-canvas rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto">
            {output}
          </pre>
        )}
      </div>
    );
  }

  return null;
}
