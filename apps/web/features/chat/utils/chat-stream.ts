import {
  buildChatSessionStreamUrl,
  chatSessionsApi,
  type ChatSessionStreamEvent,
} from '../api';

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 6;

export function getAiChatStreamReconnectDelay(attempt: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(
    INITIAL_RECONNECT_DELAY_MS * 2 ** normalizedAttempt,
    MAX_RECONNECT_DELAY_MS,
  );
}

function readStreamEvent(raw: unknown): ChatSessionStreamEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const event = JSON.parse(raw) as ChatSessionStreamEvent | null;
    return typeof event?.type === 'string' ? event : null;
  } catch {
    return null;
  }
}

export function openChatStream(
  sessionId: string,
  options: {
    isCurrent: () => boolean;
    onConnected: () => void;
    onDisconnected: () => void;
    onEvent: (
      event: Exclude<ChatSessionStreamEvent, { type: 'connected' }>,
    ) => void;
  },
): () => void {
  const ticketController = new AbortController();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const isCurrent = () =>
    !ticketController.signal.aborted && options.isCurrent();
  const clearReconnect = () => {
    if (reconnectTimer === null) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const detachSocket = () => {
    const previous = socket;
    socket = null;
    if (previous) {
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
    }
    return previous;
  };

  function scheduleReconnect() {
    if (!isCurrent() || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return;
    const delay = getAiChatStreamReconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    clearReconnect();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function connect() {
    if (!isCurrent()) return;
    let connection: WebSocket;
    try {
      const { ticket } = await chatSessionsApi.createStreamTicket(sessionId, {
        signal: ticketController.signal,
      });
      if (!isCurrent()) return;
      connection = new WebSocket(buildChatSessionStreamUrl(sessionId, ticket));
    } catch {
      scheduleReconnect();
      return;
    }

    socket = connection;
    const isCurrentSocket = () => socket === connection && isCurrent();
    connection.onmessage = ({ data }) => {
      if (!isCurrentSocket()) return;
      const event = readStreamEvent(data);
      if (!event) return;
      if (event.type === 'connected') {
        reconnectAttempt = 0;
        options.onConnected();
      } else {
        options.onEvent(event);
      }
    };
    connection.onerror = () => {
      if (isCurrentSocket()) options.onDisconnected();
    };
    connection.onclose = () => {
      if (!isCurrentSocket()) return;
      detachSocket();
      options.onDisconnected();
      scheduleReconnect();
    };
  }

  void connect();
  return () => {
    ticketController.abort();
    clearReconnect();
    detachSocket()?.close();
  };
}
