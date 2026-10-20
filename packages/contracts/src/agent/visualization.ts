import type {
  VisualizationArtifact,
  VisualizationInput,
} from '../visualization/index.js';

export const VISUALIZATION_RPC_TIMEOUT_MS = 15_000;
export type VisualizationOperation = VisualizationInput & {
  toolCallId: string;
};
export interface VisualizationIpcRequest {
  rpcId: string;
  requestId: string;
  executionId: string;
  operation: VisualizationOperation;
}
export type VisualizationResult =
  | {
      ok: true;
      sessionId: string;
      artifact: VisualizationArtifact;
      createdAt: string;
    }
  | { ok: false; code: string; error: string };
export type VisualizationCaller = (
  operation: VisualizationOperation,
  signal?: AbortSignal,
) => Promise<VisualizationResult>;

export function visualizationRequestQueue(accountId: string): string {
  return `ipc:${accountId}:visualization`;
}
export function visualizationResponseQueue(
  accountId: string,
  rpcId: string,
): string {
  return `ipc:${accountId}:visualization:reply:${rpcId}`;
}
export function isVisualizationIpcRequest(
  value: unknown,
): value is VisualizationIpcRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as VisualizationIpcRequest;
  const identifier = (item: unknown) =>
    typeof item === 'string' && item.length > 0 && item.length <= 256;
  return (
    typeof request.rpcId === 'string' &&
    /^[a-f0-9-]{36}$/.test(request.rpcId) &&
    identifier(request.requestId) &&
    identifier(request.executionId) &&
    Boolean(request.operation) &&
    typeof request.operation === 'object' &&
    identifier(request.operation.toolCallId)
  );
}
