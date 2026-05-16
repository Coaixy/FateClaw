import type {
  AgentTaskGraph,
  Artifact,
  ContainerInput,
  LlmRuntimeSnapshot,
  SkillContextEntry,
  ToolErrorInfo,
  TokenUsage,
} from '../types.js';
import type { RequestScope } from '../request-scope.js';
import type { RequestRuntime } from '../runtime.js';

export type KernelProvider = LlmRuntimeSnapshot['provider'];

export type SpecialistName =
  | 'general-assistant'
  | 'xuanxue-board-agent'
  | 'xuanxue-interpret-agent';

export interface SpecialistExecutionResult {
  specialist: SpecialistName;
  success: boolean;
  failureReason?: string;
  text: string | null;
  /** specialist 循环内最近一次结构化工具错误，供 supervisor 做用户分流。 */
  technicalFailure?: ToolErrorInfo | null;
  usage: TokenUsage;
  skillContext: SkillContextEntry[];
  newArtifacts: Artifact[];
}

export interface KernelExecutionInput {
  containerInput: ContainerInput;
  llmRuntime: LlmRuntimeSnapshot;
  runtime: RequestRuntime;
  requestScope: RequestScope;
}

export interface KernelExecutionResult {
  text: string | null;
  usage: TokenUsage;
  skillContext: SkillContextEntry[];
  agentGraph: AgentTaskGraph;
}
