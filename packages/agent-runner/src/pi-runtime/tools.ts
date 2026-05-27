import {
  defineTool,
  type AgentToolResult,
  type Skill,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import { AGENT_LOOP_TIMEOUT } from '../constants.js';
import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import { withTimeout } from '../timeout.js';
import { executePiScriptSkillTool } from './script-skill-executor.js';
import { executePiInterpretTool } from './interpret-executor.js';
import {
  getPiDeterministicScriptTools,
  toToolDefinition,
  type PiDeterministicScriptToolSpec,
} from './deterministic-tool-catalog.js';
import { createPiSkillReadTool } from './skill-read-tool.js';
import { executePiKnowledgeTool } from './knowledge-executor.js';
import {
  getPiDirectToolExecutionMode,
  listPiDirectToolSpecs,
} from './direct-tool-catalog.js';
import { executePiDirectTool } from './direct-tool-executor.js';
import type { RequestRuntime } from '../runtime.js';
import type { RequestScope } from '../request-scope.js';
import {
  getPiInterpretToolDefinition,
  getPiInterpretToolExecutionMode,
  isPiInterpretToolName,
  PI_INTERPRET_TOOL_NAME,
} from './interpret-tool-catalog.js';
import {
  getPiKnowledgeToolExecutionMode,
  isPiKnowledgeToolName,
  listPiKnowledgeToolDefinitions,
} from './knowledge-tool-catalog.js';
import type {
  ActiveBoardContext,
  ChatInputKind,
  LlmRuntimeSnapshot,
  TokenUsage,
  ToolDefinition,
  ToolExecutionMode,
  ToolExecutionOptions,
  ToolSpec,
  ToolResult,
  UserPastedBoardInput,
} from '../types.js';
import type { PiToolExecutionRecord } from './types.js';

interface PiToolDetails {
  output: string;
  modelOutput?: string;
  isError: boolean;
}

const AnyObject = Type.Unsafe<Record<string, unknown>>({
  type: 'object',
  additionalProperties: true,
});

const finalReplyParamsSchema = Type.Object({
  text: Type.String({
    description: '发送给用户的最终回复文本',
  }),
});

type AnyObjectParams = Static<typeof AnyObject>;
type FinalReplyParams = Static<typeof finalReplyParamsSchema>;

export interface CreatePiToolsOptions {
  runtime: RequestRuntime;
  requestScope: RequestScope;
  llmRuntime: LlmRuntimeSnapshot;
  enabledSkillNames?: string[];
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  activeBoardContext?: ActiveBoardContext;
  userId?: string;
  readableSkills?: Skill[];
  recordExecution(record: PiToolExecutionRecord): void;
  setFinalReply(text: string): void;
}

interface PiToolRuntimeSpec {
  definition: ToolDefinition;
  executionMode?: ToolExecutionMode;
  executeAs?:
    | {
        kind: 'scriptSkill';
        spec: PiDeterministicScriptToolSpec;
      }
    | {
        kind: 'interpret';
      }
    | {
        kind: 'knowledge';
      }
    | {
        kind: 'directTool';
        spec: ToolSpec;
      };
}

function toPiToolName(definition: ToolDefinition): string {
  return definition.function.name;
}

function toPiPromptGuidelines(definition: ToolDefinition): string[] {
  return [
    `${definition.function.name}: ${definition.function.description}`,
  ];
}

function stringifyResultContent(result: ToolResult): string {
  return result.modelOutput ?? result.output;
}

function toAgentToolResult(result: ToolResult): AgentToolResult<PiToolDetails> {
  return {
    content: [{ type: 'text', text: stringifyResultContent(result) }],
    details: {
      output: result.output,
      modelOutput: result.modelOutput,
      isError: Boolean(result.isError),
    },
    terminate: result.delivery === 'final',
  };
}

function mergeUsage(target: TokenUsage, next?: TokenUsage): void {
  if (!next) return;
  target.promptTokens += next.promptTokens;
  target.completionTokens += next.completionTokens;
  target.totalTokens += next.totalTokens;
}

function createToolExecutionOptions(args: {
  options: CreatePiToolsOptions;
  signal: AbortSignal | undefined;
}): ToolExecutionOptions {
  return {
    signal: args.signal,
    requestScope: args.options.requestScope,
    // Pi 单个 session 内多次工具调用需要共享 loopRunId，解读工具准备的知识库状态
    // 才能被后续 list/read knowledge 工具读取。
    loopRunId: `pi-${args.options.requestScope.requestId ?? 'request'}`,
    runtimeDeps: args.options.runtime.deps,
    provider: 'pi-sdk',
    model: args.options.llmRuntime.model,
    llmRuntime: args.options.llmRuntime,
    inputKind: args.options.inputKind,
    pastedBoard: args.options.pastedBoard,
    activeBoardContext: args.options.activeBoardContext,
    userId: args.options.userId,
  };
}

function resolvePiToolExecutionMode(
  spec: PiToolRuntimeSpec,
): ToolExecutionMode {
  const toolName = toPiToolName(spec.definition);
  return (
    spec.executionMode ??
    getPiDirectToolExecutionMode(toolName) ??
    getPiKnowledgeToolExecutionMode(toolName) ??
    getPiInterpretToolExecutionMode(toolName) ??
    'parallel'
  );
}

function createCustomTool(
  spec: PiToolRuntimeSpec,
  options: CreatePiToolsOptions,
): PiToolDefinition {
  const definition = spec.definition;
  const toolName = toPiToolName(definition);
  return defineTool({
    name: toolName,
    label: toolName,
    description: definition.function.description,
    promptSnippet: definition.function.description,
    promptGuidelines: toPiPromptGuidelines(definition),
    parameters: AnyObject,
    executionMode:
      resolvePiToolExecutionMode(spec) === 'parallel'
        ? 'parallel'
        : 'sequential',
    prepareArguments(args): AnyObjectParams {
      return args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    },
    async execute(
      toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<PiToolDetails>> {
      const startedAt = Date.now();
      const execution = await withTimeout(
        (timeoutSignal) => {
          const executionOptions = createToolExecutionOptions({
            options,
            signal: signal
              ? AbortSignal.any([signal, timeoutSignal])
              : timeoutSignal,
          });
          if (spec.executeAs?.kind === 'scriptSkill') {
            return executePiScriptSkillTool({
              invocation: {
                id: toolCallId,
                toolName,
                args: params,
                source: 'model',
              },
              spec: spec.executeAs.spec,
              params,
              options: executionOptions,
            });
          }
          if (spec.executeAs?.kind === 'interpret') {
            return executePiInterpretTool({
              invocation: {
                id: toolCallId,
                toolName,
                args: params,
                source: 'model',
              },
              options: executionOptions,
            });
          }
          if (spec.executeAs?.kind === 'knowledge') {
            return executePiKnowledgeTool({
              invocation: {
                id: toolCallId,
                toolName,
                args: params,
                source: 'model',
              },
              options: executionOptions,
            });
          }
          if (spec.executeAs?.kind === 'directTool') {
            return executePiDirectTool({
              invocation: {
                id: toolCallId,
                toolName,
                args: params,
                source: 'model',
              },
              spec: spec.executeAs.spec,
              options: executionOptions,
            });
          }
          throw new Error(`Pi runtime 未配置工具执行器: ${toolName}`);
        },
        AGENT_LOOP_TIMEOUT,
        `pi-tool:${toolName}`,
      );

      options.recordExecution({
        invocation: {
          id: toolCallId,
          toolName,
          args: params,
        },
        output: execution.result.output,
        modelOutput: execution.result.modelOutput,
        isError: Boolean(execution.result.isError),
        skillContextEntry: execution.skillContextEntry,
      });
      traceEvent(
        {
          type: 'pi_tool_completed',
          toolName,
          elapsedMs: Date.now() - startedAt,
          isError: Boolean(execution.result.isError),
        },
        options.requestScope,
      );

      return toAgentToolResult(execution.result);
    },
  });
}

function createFinalReplyTool(
  options: CreatePiToolsOptions,
): PiToolDefinition {
  return defineTool({
    name: 'final_reply',
    label: 'final_reply',
    description: '当你准备好向用户发送最终回复时，必须调用此工具。',
    promptSnippet: '结束本轮任务并返回用户可见文本。',
    promptGuidelines: [
      '完成任务时调用 final_reply，不要用普通 assistant 文本作为最终交付。',
    ],
    parameters: finalReplyParamsSchema,
    executionMode: 'sequential',
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiToolDetails>> {
      const text = params.text.trim();
      options.setFinalReply(text);
      appendTranscriptEvent(options.requestScope, {
        type: 'tool_use',
        invocation: {
          id: toolCallId,
          toolName: 'final_reply',
          args: { text },
          source: 'model',
        },
      });
      appendTranscriptEvent(options.requestScope, {
        type: 'tool_result',
        invocationId: toolCallId,
        ok: true,
        output: text,
      });
      traceEvent(
        {
          type: 'pi_final_reply',
          textLength: text.length,
        },
        options.requestScope,
      );
      return {
        content: [{ type: 'text', text }],
        details: { output: text, isError: false },
        terminate: true,
      };
    },
  });
}

export function createPiCustomTools(
  options: CreatePiToolsOptions,
): PiToolDefinition[] {
  const specs = [
    ...createPiCatalogToolSpecs(),
    ...createScriptSkillToolSpecs(options),
  ];
  const toolNames = new Set(specs.map((spec) => toPiToolName(spec.definition)));
  const tools = specs.map((spec) =>
    createCustomTool(spec, options),
  );
  if (options.readableSkills?.length) {
    tools.unshift(
      createPiSkillReadTool({
        requestScope: options.requestScope,
        readableSkills: options.readableSkills,
        recordExecution: options.recordExecution,
      }),
    );
    toolNames.add('read');
  }
  if (!toolNames.has('final_reply')) {
    tools.push(createFinalReplyTool(options));
  }
  return tools;
}

function createPiCatalogToolSpecs(): PiToolRuntimeSpec[] {
  return [
    {
      definition: getPiInterpretToolDefinition(),
      executionMode: getPiInterpretToolExecutionMode(PI_INTERPRET_TOOL_NAME),
      executeAs: { kind: 'interpret' as const },
    },
    ...listPiKnowledgeToolDefinitions().map((definition) => ({
      definition,
      executionMode: getPiKnowledgeToolExecutionMode(definition.function.name),
      executeAs: { kind: 'knowledge' as const },
    })),
    ...listPiDirectToolSpecs().map((spec) => ({
      definition: spec.definition,
      executionMode: spec.executionMode,
      executeAs: { kind: 'directTool' as const, spec },
    })),
  ].filter((spec) => {
    const name = spec.definition.function.name;
    return (
      isPiInterpretToolName(name) ||
      isPiKnowledgeToolName(name) ||
      spec.executeAs.kind === 'directTool'
    );
  });
}

function normalizePiSkillToolName(skillDir: string): string {
  return skillDir.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/-/g, '_');
}

function createScriptSkillToolSpec(
  deterministicTool: PiDeterministicScriptToolSpec,
): PiToolRuntimeSpec {
  const toolName = normalizePiSkillToolName(deterministicTool.skillName);
  return {
    executionMode: deterministicTool.executionMode,
    definition: toToolDefinition({
      ...deterministicTool,
      toolName,
    }),
    executeAs: {
      kind: 'scriptSkill',
      spec: {
        ...deterministicTool,
        toolName,
      },
    },
  };
}

function createScriptSkillToolSpecs(
  options: CreatePiToolsOptions,
): PiToolRuntimeSpec[] {
  if (!options.enabledSkillNames) return [];
  return getPiDeterministicScriptTools(options.enabledSkillNames).map((tool) =>
    createScriptSkillToolSpec(tool),
  );
}
