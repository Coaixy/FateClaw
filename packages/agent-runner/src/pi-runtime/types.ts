import type {
  AgentTaskGraph,
  ContainerInput,
  LlmRuntimeSnapshot,
  PiSessionSnapshot,
  SkillContextEntry,
  TokenUsage,
} from '../types.js';
import type { RequestScope } from '../request-scope.js';
import type { RequestRuntime } from '../runtime.js';

export interface PiRuntimeResult {
  text: string | null;
  usage: TokenUsage;
  skillContext: SkillContextEntry[];
  agentGraph: AgentTaskGraph;
  piSession?: PiSessionSnapshot;
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
