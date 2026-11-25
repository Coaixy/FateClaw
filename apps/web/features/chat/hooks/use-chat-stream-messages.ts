'use client';

import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import type { ChatSession, ChatSessionStreamEvent, Message } from '../api';
import { sanitizeToolPath } from '../utils/tool-path';

const STREAMING_UPDATE_INTERVAL_MS = 50;

function readToolPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const path = (value as { path?: unknown }).path;
  return typeof path === 'string' && path.trim()
    ? sanitizeToolPath(path)
    : undefined;
}

function buildToolTraceContent(args: {
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  path?: string;
}) {
  const label = args.toolName;
  const suffix =
    args.status === 'running'
      ? '中'
      : args.status === 'failed'
        ? '失败'
        : '完成';
  return args.path ? `${label}: ${args.path} ${suffix}` : `${label}${suffix}`;
}

/**
 * 将一次批量提交内累积的流式消息更新合并进当前消息列表。
 *
 * @param previous 当前消息列表。
 * @param updates 本次需要提交的最新消息快照，同一消息在入参中至多出现一次。
 * @returns 保持未变化消息引用稳定的新列表，便于消息行通过 memo 跳过历史重渲染。
 */
export function mergeStreamingMessageUpdates(
  previous: Message[],
  updates: Message[],
): Message[] {
  if (updates.length === 0) return previous;

  const next = [...previous];
  const indexById = new Map(
    previous.map((message, index) => [message.id, index] as const),
  );

  for (const update of updates) {
    const existingIndex = indexById.get(update.id);
    if (existingIndex === undefined) {
      indexById.set(update.id, next.length);
      next.push(update);
      continue;
    }
    next[existingIndex] = update;
  }

  return next;
}

export function useChatStreamMessages(
  setMessages: Dispatch<SetStateAction<Message[]>>,
  sessionsRef: RefObject<ChatSession[]>,
) {
  const streamingUpdateTimerRef = useRef<number | null>(null);
  const pendingStreamingUpdatesRef = useRef<Map<string, Message>>(new Map());
  const streamingMessageEntriesRef = useRef<Array<{ key: string; id: string }>>(
    [],
  );
  const toolTraceMessageEntriesRef = useRef<
    Array<{ key: string; id: string; args?: unknown }>
  >([]);
  const latestStreamingMessageKeyRef = useRef<string | null>(null);
  const latestThinkingMessageKeyRef = useRef<string | null>(null);
  const streamingSequenceRef = useRef(0);
  const toolTraceSequenceRef = useRef(0);

  const getActiveStreamingMessageIds = useCallback(
    () => streamingMessageEntriesRef.current.map((entry) => entry.id),
    [],
  );

  const commitPendingStreamingMessageUpdates = useCallback(() => {
    const updates = Array.from(pendingStreamingUpdatesRef.current.values());
    pendingStreamingUpdatesRef.current.clear();
    if (updates.length === 0) return;

    setMessages((previous) => mergeStreamingMessageUpdates(previous, updates));
  }, [setMessages]);

  const flushStreamingMessageUpdates = useCallback(() => {
    if (streamingUpdateTimerRef.current !== null) {
      window.clearTimeout(streamingUpdateTimerRef.current);
      streamingUpdateTimerRef.current = null;
    }
    commitPendingStreamingMessageUpdates();
  }, [commitPendingStreamingMessageUpdates]);

  const queueStreamingMessageUpdate = useCallback(
    (message: Message) => {
      // 一个提交窗口内只保留每条流式消息的最后快照，避免模型 token 频率直接变成 React 提交频率。
      pendingStreamingUpdatesRef.current.set(message.id, message);
      if (streamingUpdateTimerRef.current !== null) return;

      streamingUpdateTimerRef.current = window.setTimeout(() => {
        streamingUpdateTimerRef.current = null;
        commitPendingStreamingMessageUpdates();
      }, STREAMING_UPDATE_INTERVAL_MS);
    },
    [commitPendingStreamingMessageUpdates],
  );

  const resetStreamingMessageRefs = useCallback(() => {
    if (streamingUpdateTimerRef.current !== null) {
      window.clearTimeout(streamingUpdateTimerRef.current);
      streamingUpdateTimerRef.current = null;
    }
    pendingStreamingUpdatesRef.current.clear();
    streamingMessageEntriesRef.current = [];
    latestStreamingMessageKeyRef.current = null;
    latestThinkingMessageKeyRef.current = null;
    toolTraceMessageEntriesRef.current = [];
  }, []);

  const beginStreamingAssistantTurn = useCallback((turnIndex?: number) => {
    const key =
      typeof turnIndex === 'number'
        ? `turn-${turnIndex}`
        : `turn-${streamingSequenceRef.current}`;
    latestStreamingMessageKeyRef.current = key;
    latestThinkingMessageKeyRef.current = `thinking-${key}`;
    return key;
  }, []);

  const upsertStreamingAssistantMessage = useCallback(
    (
      sessionId: string,
      content: string,
      streamKey?: string | null,
      metadata?: Message['metadata'],
      streamOptions?: { updateLatestKey?: boolean },
    ) => {
      const key =
        streamKey ??
        latestStreamingMessageKeyRef.current ??
        `message-${streamingSequenceRef.current}`;
      let entry = streamingMessageEntriesRef.current.find(
        (item) => item.key === key,
      );
      if (!entry) {
        entry = {
          key,
          id: `stream-bot-${Date.now()}-${streamingSequenceRef.current}`,
        };
        streamingSequenceRef.current += 1;
        streamingMessageEntriesRef.current = [
          ...streamingMessageEntriesRef.current,
          entry,
        ];
      }
      if (streamOptions?.updateLatestKey !== false) {
        latestStreamingMessageKeyRef.current = key;
      }
      const accountId =
        sessionsRef.current.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';

      queueStreamingMessageUpdate({
        id: entry.id,
        account_id: accountId,
        sender: '',
        sender_name: '',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
        metadata: metadata ?? {
          kind: 'streaming',
        },
      });
    },
    [queueStreamingMessageUpdate, sessionsRef],
  );

  const upsertThinkingMessage = useCallback(
    (sessionId: string, content: string, turnIndex?: number) => {
      const text = content.trim();
      if (!text) return;
      const baseKey =
        typeof turnIndex === 'number'
          ? `turn-${turnIndex}`
          : (latestStreamingMessageKeyRef.current ??
            `turn-${streamingSequenceRef.current}`);
      const key =
        typeof turnIndex === 'number'
          ? `thinking-${baseKey}`
          : (latestThinkingMessageKeyRef.current ?? `thinking-${baseKey}`);
      latestThinkingMessageKeyRef.current = key;

      upsertStreamingAssistantMessage(
        sessionId,
        text,
        key,
        {
          kind: 'thinking',
          stage: 'thinking',
          workflow: 'pi_runtime',
        },
        { updateLatestKey: false },
      );
    },
    [upsertStreamingAssistantMessage],
  );

  const upsertToolTraceMessage = useCallback(
    (
      sessionId: string,
      content: string,
      traceOptions: {
        key: string;
        toolName: string;
        status: 'running' | 'completed' | 'failed';
        path?: string;
        args?: unknown;
      },
    ) => {
      let entry = toolTraceMessageEntriesRef.current.find(
        (item) => item.key === traceOptions.key,
      );
      if (!entry) {
        entry = {
          key: traceOptions.key,
          id: `tool-trace-${Date.now()}-${toolTraceSequenceRef.current}`,
          args: traceOptions.args,
        };
        toolTraceSequenceRef.current += 1;
        toolTraceMessageEntriesRef.current = [
          ...toolTraceMessageEntriesRef.current,
          entry,
        ];
      } else if (traceOptions.args !== undefined) {
        entry.args = traceOptions.args;
      }

      const accountId =
        sessionsRef.current.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';

      setMessages((previous) => {
        const existingIndex = previous.findIndex(
          (message) => message.id === entry.id,
        );
        const nextMessage: Message = {
          id: entry.id,
          account_id: accountId,
          sender: '',
          sender_name: '',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          metadata: {
            kind: 'tool_trace',
            stage: `tool_${traceOptions.status}`,
            workflow: 'pi_runtime',
            tool_call_id: traceOptions.key,
            tool_name: traceOptions.toolName,
            tool_label: traceOptions.toolName,
            tool_status: traceOptions.status,
            tool_path: traceOptions.path,
          },
        };

        if (existingIndex >= 0) {
          const next = [...previous];
          next[existingIndex] = nextMessage;
          return next;
        }

        return [...previous, nextMessage];
      });
    },
    [sessionsRef, setMessages],
  );

  const projectToolCall = useCallback(
    (
      sessionId: string,
      event: Extract<
        ChatSessionStreamEvent,
        { type: 'tool_start' | 'tool_update' | 'tool_end' }
      >,
    ) => {
      const finishing = event.type === 'tool_end';
      const args = finishing
        ? toolTraceMessageEntriesRef.current.find(
            (entry) => entry.key === event.toolCallId,
          )?.args
        : event.args;
      const path = readToolPath(args);
      const status = finishing
        ? event.isError
          ? 'failed'
          : 'completed'
        : 'running';
      upsertToolTraceMessage(
        sessionId,
        buildToolTraceContent({ toolName: event.toolName, status, path }),
        {
          key: event.toolCallId,
          toolName: event.toolName,
          status,
          path,
          args: finishing ? undefined : event.args,
        },
      );
    },
    [upsertToolTraceMessage],
  );

  const finalizeRunningToolTraceMessages = useCallback(
    (status: 'completed' | 'failed') => {
      setMessages((previous) => {
        let changed = false;
        const next = previous.map((message) => {
          const metadata =
            message.metadata &&
            typeof message.metadata === 'object' &&
            !Array.isArray(message.metadata)
              ? (message.metadata as Record<string, unknown>)
              : null;
          if (
            !metadata ||
            metadata.kind !== 'tool_trace' ||
            metadata.tool_status !== 'running'
          ) {
            return message;
          }

          const toolName =
            typeof metadata.tool_name === 'string'
              ? metadata.tool_name
              : typeof metadata.tool_label === 'string'
                ? metadata.tool_label
                : 'tool';
          const path =
            typeof metadata.tool_path === 'string'
              ? sanitizeToolPath(metadata.tool_path)
              : undefined;
          changed = true;

          return {
            ...message,
            content: buildToolTraceContent({
              toolName,
              status,
              path,
            }),
            metadata: {
              ...metadata,
              stage: `tool_${status}`,
              tool_status: status,
              tool_path: path,
            },
          };
        });

        return changed ? next : previous;
      });
    },
    [setMessages],
  );

  return {
    getActiveStreamingMessageIds,
    flushStreamingMessageUpdates,
    resetStreamingMessageRefs,
    beginStreamingAssistantTurn,
    upsertStreamingAssistantMessage,
    upsertThinkingMessage,
    upsertToolTraceMessage,
    projectToolCall,
    finalizeRunningToolTraceMessages,
  };
}
