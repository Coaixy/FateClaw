import path from 'path';
import fs from 'fs';

import { SKILL_SCRIPT_MAX_OUTPUT, SKILL_SCRIPT_TIMEOUT } from '../constants.js';
import { getDefaultAgentRuntimeDeps } from '../deps.js';
import { log } from '../io.js';
import { SKILLS_DIR } from '../paths.js';
import { validateSkillInput } from '../skill-param-validator.js';
import { buildSkillEnv } from '../skill-env.js';
import { createToolErrorResult } from '../tools/skill/tool-error.js';
import {
  ensureOfficialScriptDependenciesAccessible,
} from '../official-script-deps.js';
import { throwIfAborted } from '../timeout.js';
import {
  hasExecutedSkillScript,
  markSkillScriptExecuted,
} from '../request-scope.js';
import type { ToolExecutionOptions, ToolResult } from '../types.js';
import type { PiDeterministicScriptToolSpec } from './deterministic-tool-catalog.js';

function resolveInterpreter(script: string): string | null {
  const ext = path.extname(script).toLowerCase();
  switch (ext) {
    case '.sh':
      return '/bin/bash';
    case '.py':
      return 'python3';
    case '.js':
      return process.execPath;
    default:
      return null;
  }
}

function buildValidationUserMessage(
  validation: ReturnType<typeof validateSkillInput>,
): string {
  const fields = validation.issue?.fields?.join('、');
  if (!fields) return '参数不完整或格式不正确，请补充或修正后我再继续处理。';
  return `参数不完整或格式不正确，请检查 ${fields} 后重新提交。`;
}

function buildValidationErrorResult(args: {
  spec: PiDeterministicScriptToolSpec;
  error: ReturnType<typeof validateSkillInput>;
}): ToolResult {
  const missingLike = new Set([
    'required',
    'conditional_required',
    'at_least_one',
    'all_or_none',
  ]);
  return createToolErrorResult({
    code: missingLike.has(args.error.issue?.code ?? '')
      ? 'SKILL.PARAM_MISSING'
      : 'SKILL.PARAM_INVALID',
    kind: 'validation',
    retryable: true,
    userSafe: true,
    nextAction: missingLike.has(args.error.issue?.code ?? '')
      ? 'ask_user'
      : 'fix_arguments',
    internalMessage: `参数错误: ${args.error.error ?? '参数校验失败'}`,
    userMessage: buildValidationUserMessage(args.error),
    details: {
      skillName: args.spec.skillName,
      toolName: args.spec.toolName,
      validationIssue: args.error.issue,
      validationMessage: args.error.error,
    },
  });
}

export async function executePiDeterministicScript(args: {
  spec: PiDeterministicScriptToolSpec;
  params: Record<string, unknown>;
  options: ToolExecutionOptions;
}): Promise<ToolResult> {
  const requestScope = args.options.requestScope;
  if (!requestScope) {
    throw new Error('executePiDeterministicScript 缺少 requestScope');
  }

  const deps = args.options.runtimeDeps ?? getDefaultAgentRuntimeDeps();
  const enabledSkillNames = await deps.skillCatalog.listEnabledSkillNames(
    args.options.userId,
  );
  if (!enabledSkillNames.includes(args.spec.displayName)) {
    return createToolErrorResult({
      code: 'SKILL.NOT_ENABLED',
      kind: 'availability',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `Skill "${args.spec.skillName}" 未启用，请在管理面板中开启后再使用。`,
      details: {
        skillName: args.spec.skillName,
        displayName: args.spec.displayName,
        toolName: args.spec.toolName,
        userId: args.options.userId,
      },
    });
  }

  const validation = validateSkillInput(
    JSON.stringify(args.params),
    args.spec.parameters,
  );
  if (!validation.valid) {
    return buildValidationErrorResult({
      spec: args.spec,
      error: validation,
    });
  }

  const skillsDir = args.options.skillsDirOverride ?? SKILLS_DIR;
  const scriptPath = path.join(skillsDir, args.spec.skillName, args.spec.script);
  if (!fs.existsSync(scriptPath)) {
    return createToolErrorResult({
      code: 'SKILL.SCRIPT_NOT_FOUND',
      kind: 'not_found',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `脚本文件不存在: ${args.spec.skillName}/${args.spec.script}`,
      details: {
        skillName: args.spec.skillName,
        script: args.spec.script,
        scriptPath,
      },
    });
  }

  const interpreter = resolveInterpreter(args.spec.script);
  if (!interpreter) {
    return createToolErrorResult({
      code: 'SKILL.SCRIPT_UNSUPPORTED',
      kind: 'validation',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `不支持的脚本类型: ${args.spec.script}`,
      details: {
        skillName: args.spec.skillName,
        script: args.spec.script,
      },
    });
  }

  if (
    hasExecutedSkillScript(requestScope, args.spec.skillName, args.spec.script, {
      loopIteration: args.options.loopIteration,
      loopRunId: args.options.loopRunId,
    })
  ) {
    return {
      output: `重复调用已跳过：第${args.options.loopIteration ?? 0}轮已经执行过 ${args.spec.skillName}/${args.spec.script}。同一轮请直接使用第一次执行结果。`,
      skipArtifact: true,
      error: {
        code: 'SKILL.DUPLICATE_SAME_LOOP',
        kind: 'conflict',
        retryable: true,
        userSafe: false,
        nextAction: 'retry_next_turn',
        internalMessage: `重复调用已跳过：第${args.options.loopIteration ?? 0}轮已经执行过 ${args.spec.skillName}/${args.spec.script}。同一轮请直接使用第一次执行结果。`,
        details: {
          skillName: args.spec.skillName,
          script: args.spec.script,
          loopIteration: args.options.loopIteration ?? 0,
          loopRunId: args.options.loopRunId ?? null,
        },
      },
    };
  }

  ensureOfficialScriptDependenciesAccessible(skillsDir);
  const stdin = JSON.stringify(validation.data ?? args.params);
  const tag = `[pi-skill:${args.spec.skillName}/${args.spec.script}]`;
  log(`${tag} 启动: interpreter=${interpreter} stdinLen=${stdin.length}`);
  throwIfAborted(args.options.signal, `${tag} 已取消`);

  const startTime = Date.now();
  const execution = await deps.skillExecutor.execute({
    interpreter,
    scriptPath,
    args: [],
    timeout: SKILL_SCRIPT_TIMEOUT,
    maxBuffer: SKILL_SCRIPT_MAX_OUTPUT * 2,
    cwd: path.join(skillsDir, args.spec.skillName),
    signal: args.options.signal,
    env: buildSkillEnv(
      args.spec.skillName,
      path.join(skillsDir, args.spec.skillName),
    ),
    stdin,
  });
  const elapsed = Date.now() - startTime;
  const stdout = execution.stdout || '';
  const stderr = execution.stderr || '';
  const combinedOutput = [
    stdout ? stdout.slice(0, SKILL_SCRIPT_MAX_OUTPUT) : '',
    stderr ? `[stderr] ${stderr.slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (execution.errorMessage) {
    const reason = execution.killed
      ? `脚本执行超时 (${SKILL_SCRIPT_TIMEOUT}ms)`
      : execution.errorMessage;
    log(`${tag} 失败 (${elapsed}ms): ${reason}`);
    return createToolErrorResult({
      code: execution.killed ? 'SKILL.SCRIPT_TIMEOUT' : 'SKILL.SCRIPT_CRASH',
      kind: execution.killed ? 'timeout' : 'execution',
      retryable: true,
      userSafe: false,
      nextAction: 'retry',
      internalMessage: combinedOutput ? `${reason}\n\n${combinedOutput}` : reason,
      details: {
        skillName: args.spec.skillName,
        script: args.spec.script,
        elapsed,
        timeout: SKILL_SCRIPT_TIMEOUT,
        killed: execution.killed,
      },
    });
  }

  markSkillScriptExecuted(requestScope, args.spec.skillName, args.spec.script, {
    loopIteration: args.options.loopIteration,
    loopRunId: args.options.loopRunId,
  });
  log(
    `${tag} 完成 (${elapsed}ms): stdoutLen=${stdout.length} stderrLen=${stderr.length}`,
  );
  return { output: combinedOutput || '(脚本无输出)' };
}
