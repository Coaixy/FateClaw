import { listScopedTraceEvents, type RequestScope } from '../request-scope.js';
import { listTranscriptEvents } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import type {
  ContainerOutput,
  SkillContextEntry,
  ToolErrorInfo,
  ToolResult,
} from '../types.js';
import type { AgentRuntimeDeps } from '../deps.js';
import { executePiScriptSkillTool } from './script-skill-executor.js';
import {
  PI_DETERMINISTIC_SCRIPT_TOOLS,
  type PiDeterministicScriptToolSpec,
} from './deterministic-tool-catalog.js';

const PI_PAIPAN_PROVIDER = 'pi-sdk';
const PI_PAIPAN_MODEL = 'pi-deterministic-paipan';

function findPaipanSpec(
  skillDir: string,
): PiDeterministicScriptToolSpec | undefined {
  return PI_DETERMINISTIC_SCRIPT_TOOLS.find(
    (spec) => spec.skillName === skillDir,
  );
}

function collectOutput(args: {
  requestScope: RequestScope;
  output: Omit<ContainerOutput, 'transcript' | 'traceEvents'>;
}): ContainerOutput {
  const transcript = listTranscriptEvents(args.requestScope);
  const traceEvents = listScopedTraceEvents(args.requestScope);
  return {
    ...args.output,
    transcript: transcript.length > 0 ? transcript : undefined,
    traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
  };
}

function mapToolErrorToPublic(
  result: ToolResult,
): {
  publicErrorText: string;
  publicReasonCode: string;
} {
  const error = result.error;
  if (!error) {
    return {
      publicErrorText: '排盘服务暂时不可用，请稍后重试',
      publicReasonCode: 'paipan_execution_failed',
    };
  }

  switch (error.code) {
    case 'SKILL.PARAM_MISSING':
    case 'SKILL.PARAM_INVALID':
      return {
        publicErrorText:
          error.userMessage || '参数不完整或格式不正确，请检查后重新提交。',
        publicReasonCode: 'paipan_param_invalid',
      };
    case 'SKILL.NOT_ENABLED':
      return {
        publicErrorText: '该排盘 Skill 当前未启用',
        publicReasonCode: 'paipan_skill_not_enabled',
      };
    case 'SKILL.NOT_FOUND':
    case 'SKILL.SCRIPT_NOT_FOUND':
    case 'SKILL.SCRIPT_UNSUPPORTED':
      return {
        publicErrorText: '未找到可用的排盘 Skill',
        publicReasonCode: 'paipan_skill_not_found',
      };
    default:
      return {
        publicErrorText: '排盘服务暂时不可用，请稍后重试',
        publicReasonCode: 'paipan_execution_failed',
      };
  }
}

function buildUnsupportedSkillError(skillDir: string): ToolErrorInfo {
  return {
    code: 'SKILL.NOT_FOUND',
    kind: 'not_found',
    retryable: false,
    userSafe: true,
    nextAction: 'stop',
    userMessage: `未找到排盘 Skill "${skillDir}"`,
    internalMessage: `未找到 Pi 排盘工具 spec: ${skillDir}`,
    details: { skillDir },
  };
}

function buildErrorOutput(args: {
  requestScope: RequestScope;
  error: ToolErrorInfo;
  publicErrorText: string;
  publicReasonCode: string;
}): ContainerOutput {
  return collectOutput({
    requestScope: args.requestScope,
    output: {
      status: 'error',
      result: null,
      error: args.error.internalMessage,
      publicErrorText: args.publicErrorText,
      publicReasonCode: args.publicReasonCode,
      provider: PI_PAIPAN_PROVIDER,
      model: PI_PAIPAN_MODEL,
    },
  });
}

function normalizeSkillContextEntry(
  entry: SkillContextEntry | undefined,
  title: string,
): SkillContextEntry | undefined {
  if (!entry) return undefined;
  return {
    ...entry,
    artifactTitle: title,
  };
}

export async function executePiPaipanRequest(args: {
  accountId: string;
  userId: string;
  skillDir: string;
  input: Record<string, unknown>;
  displayTitle?: string;
  requestScope: RequestScope;
  deps: AgentRuntimeDeps;
}): Promise<ContainerOutput> {
  const spec = findPaipanSpec(args.skillDir);
  const title = args.displayTitle || spec?.displayName || args.skillDir;
  traceEvent(
    {
      type: 'pi_paipan_request_start',
      accountId: args.accountId,
      userId: args.userId,
      skillDir: args.skillDir,
    },
    args.requestScope,
  );

  if (!spec) {
    const error = buildUnsupportedSkillError(args.skillDir);
    traceEvent(
      {
        type: 'pi_paipan_request_rejected',
        skillDir: args.skillDir,
        errorCode: error.code,
      },
      args.requestScope,
    );
    return buildErrorOutput({
      requestScope: args.requestScope,
      error,
      publicErrorText: error.userMessage || '未找到可用的排盘 Skill',
      publicReasonCode: 'paipan_skill_not_found',
    });
  }

  const execution = await executePiScriptSkillTool({
    invocation: {
      id: `paipan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolName: spec.toolName,
      args: args.input,
      source: 'model',
      displayTitle: title,
    },
    spec,
    params: args.input,
    options: {
      requestScope: args.requestScope,
      runtimeDeps: args.deps,
      provider: PI_PAIPAN_PROVIDER,
      model: PI_PAIPAN_MODEL,
      userId: args.userId,
      loopRunId: `pi-paipan-${args.requestScope.requestId ?? 'request'}`,
    },
  });

  if (execution.result.isError) {
    const mapped = mapToolErrorToPublic(execution.result);
    traceEvent(
      {
        type: 'pi_paipan_request_failed',
        skillDir: args.skillDir,
        errorCode: execution.result.error?.code,
        publicReasonCode: mapped.publicReasonCode,
      },
      args.requestScope,
    );
    return buildErrorOutput({
      requestScope: args.requestScope,
      error:
        execution.result.error ??
        buildUnsupportedSkillError(args.skillDir),
      publicErrorText: mapped.publicErrorText,
      publicReasonCode: mapped.publicReasonCode,
    });
  }

  const skillContextEntry = normalizeSkillContextEntry(
    execution.skillContextEntry,
    title,
  );
  traceEvent(
    {
      type: 'pi_paipan_request_completed',
      skillDir: args.skillDir,
      hasSkillContext: Boolean(skillContextEntry),
    },
    args.requestScope,
  );

  return collectOutput({
    requestScope: args.requestScope,
    output: {
      status: 'success',
      result: `已生成：${title}`,
      skillContext: skillContextEntry ? [skillContextEntry] : undefined,
      provider: PI_PAIPAN_PROVIDER,
      model: PI_PAIPAN_MODEL,
    },
  });
}
