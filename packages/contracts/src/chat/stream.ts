interface ChatStreamEventIdentity {
  eventId?: string;
  timestamp?: string;
  requestId?: string;
  accountId?: string;
  sessionId?: string;
}

export interface ChatSessionStreamTicket {
  ticket: string;
  expiresAt: string;
}

export type ChatSessionStreamEvent = ChatStreamEventIdentity &
  (
    | {
        type: 'connected';
      }
    | {
        type: 'agent_start' | 'agent_end' | 'turn_start';
        turnIndex?: number;
        willRetry?: boolean;
        messageCount?: number;
      }
    | {
        type: 'assistant_delta';
        delta: string;
        snapshot: string;
        turnIndex?: number;
      }
    | {
        type: 'thinking_delta';
        delta: string;
        snapshot: string;
        turnIndex?: number;
      }
    | {
        type: 'assistant_message';
        text: string;
        turnIndex?: number;
      }
    | {
        type: 'tool_start' | 'tool_update' | 'tool_end';
        toolCallId: string;
        toolName: string;
        args?: unknown;
        partialResult?: unknown;
        result?: unknown;
        isError?: boolean;
      }
    | {
        type: 'progress';
        text: string;
        stage?: string;
        workflow?: string;
        metadata?: unknown;
      }
    | {
        type: 'message';
        text: string;
        metadata?: unknown;
        skillContext?: unknown;
      }
    | {
        type: 'final';
        text: string;
        status: 'success' | 'error';
        usage?: {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        };
        metadata?: unknown;
      }
    | {
        type: 'error';
        error: string;
        publicErrorText?: string;
        publicReasonCode?: string;
      }
    | {
        type: 'usage';
        usage: {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        };
      }
  );
