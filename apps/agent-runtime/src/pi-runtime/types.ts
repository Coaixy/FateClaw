import type {
  AgentTaskGraph,
  ContainerInput,
  LlmRuntimeSnapshot,
  PiSessionSnapshot,
  SkillContextEntry,
  TokenUsage,
} from '#agent/types';
import type { RequestScope } from '#agent/request-scope';
import type { RequestRuntime } from '#agent/runtime';

export interface PiRuntimeResult {
  text: string | null;
  usage: TokenUsage;
  skillContext: SkillContextEntry[];
  agentGraph: AgentTaskGraph;
  piSession?:
    | PiSessionSnapshot
    | import('@fateclaw/contracts/agent').PiSessionFrame;
}

export interface PiRuntimeInput {
  containerInput: ContainerInput;
  llmRuntime: LlmRuntimeSnapshot;
  runtime: RequestRuntime;
  requestScope: RequestScope;
  /** session 创建完成后暴露最小控制面，宿主可据此中断当前 turn。 */
  onSessionReady?: (sessionControls: { abort: () => Promise<void> }) => void;
}

export interface PiInvocation {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PiToolExecutionRecord {
  invocation: PiInvocation;
  output: string;
  modelOutput?: string;
  isError: boolean;
  skillContextEntry?: SkillContextEntry;
}
