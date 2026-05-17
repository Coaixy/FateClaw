/**
 * run_skill_script 工具 — 执行 skill 目录下的脚本文件。
 *
 * 支持 .sh / .py / .js 三种脚本类型。
 * 包含路径穿越防护、扩展名白名单、超时控制等安全机制。
 */

import fs from 'fs';
import path from 'path';

import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import type { ToolResult, ToolSpec } from '../../types.js';
import type { SkillParametersSchema } from '../../prompt/types.js';
import {
  validateSkillInput,
  type ValidationResult,
} from '../../skill-param-validator.js';
import { SKILLS_DIR } from '../../paths.js';
import {
  SKILL_SCRIPT_TIMEOUT,
  SKILL_SCRIPT_MAX_OUTPUT,
} from '../../constants.js';
import { buildSkillEnv } from '../../skill-env.js';
import { log } from '../../io.js';
import type { RequestScope } from '../../request-scope.js';
import {
  hasExecutedSkillScript,
  markSkillScriptExecuted,
} from '../../request-scope.js';
import { throwIfAborted } from '../../timeout.js';
import {
  ensureRunnableSkillReady,
  resolveSkillAction,
} from './skill-runtime.js';
import { createToolErrorResult } from './tool-error.js';

const ALLOWED_EXTENSIONS = new Set(['.sh', '.py', '.js']);
const SKILL_RUNTIME_DEPENDENCY_PACKAGES = [
  'bazi-ts-lib',
  'iching-shifa',
  'iztro',
  'kinqimen',
] as const;

function resolveSkillNodeModulesDir(skillsDir: string): string {
  return path.resolve(skillsDir, '..', 'node_modules');
}

function resolveFallbackNodeModulesDirs(skillsDir: string): string[] {
  const projectRoot = path.resolve(skillsDir, '..', '..');
  return [
    path.join(projectRoot, 'apps', 'api', 'node_modules'),
    path.join(projectRoot, 'packages', 'agent-runner', 'node_modules'),
  ];
}

/**
 * 确保官方 Skill 脚本能解析到自身运行时依赖。
 *
 * 正常形态下这些依赖应安装在 `skills/node_modules`。
 * 为兼容旧部署（依赖仍落在 apps/api/node_modules），这里会按需补齐符号链接。
 */
export function ensureSkillRuntimeDependenciesAccessible(
  skillsDir: string,
): void {
  const skillNodeModulesDir = resolveSkillNodeModulesDir(skillsDir);
  const fallbackDirs = resolveFallbackNodeModulesDirs(skillsDir).filter((dir) =>
    fs.existsSync(dir),
  );

  if (fallbackDirs.length === 0) {
    return;
  }

  fs.mkdirSync(skillNodeModulesDir, { recursive: true });

  for (const packageName of SKILL_RUNTIME_DEPENDENCY_PACKAGES) {
    const targetPath = path.join(skillNodeModulesDir, packageName);
    if (fs.existsSync(targetPath)) {
      continue;
    }

    const sourcePath = fallbackDirs
      .map((dir) => path.join(dir, packageName))
      .find((candidate) => fs.existsSync(candidate));
    if (!sourcePath) {
      continue;
    }

    fs.symlinkSync(
      sourcePath,
      targetPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

/** 解析脚本扩展名对应的解释器。 */
function resolveInterpreter(ext: string): string | null {
  switch (ext) {
    case '.sh':
      return '/bin/bash';
    case '.py':
      return 'python3';
    case '.js':
      // 使用当前 Node 可执行文件，避免 Windows 服务环境 PATH 缺失时找不到 `node`。
      return process.execPath;
    default:
      return null;
  }
}

function describeSkillFields(
  fields: string[] | undefined,
  schema?: SkillParametersSchema,
): string {
  return (fields ?? [])
    .map((field) => {
      const normalizedField = field.replace(/\[\d+\]$/, '');
      const description = schema?.properties?.[normalizedField]?.description;
      return description ? `${field}（${description}）` : field;
    })
    .join('、');
}

function buildValidationUserMessage(
  validation: ValidationResult,
  schema?: SkillParametersSchema,
): string {
  const issue = validation.issue;
  if (!issue) {
    return '参数不完整或格式不正确，请补充或修正后我再继续处理。';
  }

  switch (issue.code) {
    case 'required':
    case 'conditional_required': {
      const fields = describeSkillFields(issue.fields, schema);
      return fields
        ? `还缺少必要参数：${fields}。请补充后我继续处理。`
        : '还缺少必要参数，请补充后我继续处理。';
    }
    case 'at_least_one': {
      const fields = describeSkillFields(issue.fields, schema);
      return fields
        ? `还缺少必要参数，请至少提供 ${fields} 其中一项。`
        : '还缺少必要参数，请至少补充一项后我继续处理。';
    }
    case 'all_or_none': {
      const missingFields = describeSkillFields(issue.fields, schema);
      const groupFields = describeSkillFields(issue.groupFields, schema);
      if (missingFields && groupFields) {
        return `参数 ${groupFields} 需要成组提供；当前还缺少 ${missingFields}。请补齐后我继续处理。`;
      }
      return '有一组参数需要同时提供，请补齐后我继续处理。';
    }
    default: {
      const fields = describeSkillFields(issue.fields, schema);
      return fields
        ? `参数格式不正确，请检查 ${fields} 后重新提交。`
        : '参数格式不正确，请修正后我再继续处理。';
    }
  }
}

function buildValidationErrorResult(args: {
  skillName: string;
  script: string;
  validation: ValidationResult;
  schema?: SkillParametersSchema;
}): ToolResult {
  const issue = args.validation.issue;
  const isMissingLike =
    issue?.code === 'required' ||
    issue?.code === 'conditional_required' ||
    issue?.code === 'at_least_one' ||
    issue?.code === 'all_or_none';
  return createToolErrorResult({
    code: isMissingLike ? 'SKILL.PARAM_MISSING' : 'SKILL.PARAM_INVALID',
    kind: 'validation',
    retryable: true,
    userSafe: true,
    nextAction: isMissingLike ? 'ask_user' : 'fix_arguments',
    internalMessage: `参数错误: ${args.validation.error ?? '参数校验失败'}`,
    userMessage: buildValidationUserMessage(args.validation, args.schema),
    details: {
      skillName: args.skillName,
      script: args.script,
      validationIssue: issue,
      validationMessage: args.validation.error,
    },
  });
}

/**
 * 执行 skill 脚本的核心函数。
 * 同时被 run_skill_script 和 interpret_xuanxue 调用。
 */
export async function executeRunSkillScript(rawArgs: {
  skill_name: string;
  script: string;
  args?: string[];
  stdin?: string;
}, options?: {
  signal?: AbortSignal;
  requestScope?: RequestScope;
  loopIteration?: number;
  loopRunId?: string;
  skillsDir?: string;
  bypassLoadRequirement?: boolean;
  runtimeDeps?: import('../../deps.js').AgentRuntimeDeps;
}): Promise<ToolResult> {
  // args 可能被参数校验后替换（填充默认值），使用局部引用
  let args = rawArgs;
  const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();
  const ready = await ensureRunnableSkillReady(args.skill_name, {
    requestScope: options?.requestScope,
    skillsDirOverride: options?.skillsDir ?? SKILLS_DIR,
    bypassLoadRequirement: options?.bypassLoadRequirement,
    runtimeDeps: deps,
  });
  const baseTag = `[skill:${args.skill_name}/${args.script}]`;
  if (!ready.ok) {
    log(`${baseTag} 拒绝: ${ready.result.output}`);
    return ready.result;
  }

  const matched = ready.skill;
  const skillsDir = ready.skillsDir;

  const resolvedAction = resolveSkillAction(matched, args.script);
  if ('output' in resolvedAction) {
    log(`${baseTag} 拒绝: ${resolvedAction.output}`);
    return resolvedAction;
  }

  const action = resolvedAction;
  const tag = `[skill:${args.skill_name}/${action.file}]`;

  const ext = path.extname(action.file).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    log(`${tag} 拒绝: 不支持的脚本类型 "${ext}"`);
    return createToolErrorResult({
      code: 'SKILL.SCRIPT_UNSUPPORTED',
      kind: 'validation',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `不支持的脚本类型 "${ext}"，仅允许: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
      details: {
        skillName: args.skill_name,
        script: action.file,
        extension: ext,
        allowedExtensions: [...ALLOWED_EXTENSIONS],
      },
    });
  }

  const scriptPath = path.join(skillsDir, args.skill_name, action.file);
  if (!fs.existsSync(scriptPath)) {
    log(`${tag} 拒绝: 脚本文件不存在 ${scriptPath}`);
    return createToolErrorResult({
      code: 'SKILL.SCRIPT_NOT_FOUND',
      kind: 'not_found',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `脚本文件不存在: ${args.skill_name}/${action.file}`,
      details: {
        skillName: args.skill_name,
        script: action.file,
        scriptPath,
      },
    });
  }

  const interpreter = resolveInterpreter(ext);
  if (!interpreter) {
    log(`${tag} 拒绝: 无法确定 "${ext}" 的解释器`);
    return createToolErrorResult({
      code: 'SKILL.SCRIPT_UNSUPPORTED',
      kind: 'validation',
      retryable: false,
      userSafe: false,
      nextAction: 'stop',
      internalMessage: `无法确定 "${ext}" 的解释器。`,
      details: {
        skillName: args.skill_name,
        script: action.file,
        extension: ext,
      },
    });
  }

  // 旧部署里排盘依赖可能还挂在 apps/api/node_modules，这里按需补齐 skills/node_modules 链接。
  ensureSkillRuntimeDependenciesAccessible(skillsDir);

  // 参数 Schema 验证：有 schema 时强制校验 stdin，并用填充了默认值的数据替换原始 stdin
  const validationSchema = action.parameters ?? matched.parameters;
  if (validationSchema) {
    const validation = validateSkillInput(args.stdin, validationSchema);
    if (!validation.valid) {
      log(`${tag} 参数校验失败: ${validation.error}`);
      return buildValidationErrorResult({
        skillName: args.skill_name,
        script: action.file,
        validation,
        schema: validationSchema,
      });
    }
    // 用带默认值的干净数据覆盖 stdin
    if (validation.data) {
      args = { ...args, stdin: JSON.stringify(validation.data) };
    }
  }

  const scriptArgs = args.args ?? [];
  if (
    options?.requestScope &&
    hasExecutedSkillScript(options.requestScope, args.skill_name, action.file, {
      loopIteration: options.loopIteration,
      loopRunId: options.loopRunId,
    })
  ) {
    log(`${tag} 跳过: 本轮已执行过该 skill 脚本`);
    return {
      output: `重复调用已跳过：第${options.loopIteration ?? 0}轮已经执行过 ${args.skill_name}/${action.file}。同一轮请直接使用第一次执行结果。`,
      skipArtifact: true,
      error: {
        code: 'SKILL.DUPLICATE_SAME_LOOP',
        kind: 'conflict',
        retryable: true,
        userSafe: false,
        nextAction: 'retry_next_turn',
        internalMessage: `重复调用已跳过：第${options.loopIteration ?? 0}轮已经执行过 ${args.skill_name}/${action.file}。同一轮请直接使用第一次执行结果。`,
        details: {
          skillName: args.skill_name,
          script: action.file,
          loopIteration: options.loopIteration ?? 0,
          loopRunId: options.loopRunId ?? null,
        },
      },
    };
  }

  const timeout = SKILL_SCRIPT_TIMEOUT;
  const stdinLen = args.stdin?.length ?? 0;
  log(
    `${tag} 启动: interpreter=${interpreter} timeout=${timeout}ms stdinLen=${stdinLen}`,
  );
  throwIfAborted(options?.signal, `${tag} 已取消`);
  if (args.stdin) {
    log(
      `${tag} stdin: ${args.stdin.slice(0, 500)}${stdinLen > 500 ? '...(truncated)' : ''}`,
    );
  }

  const startTime = Date.now();
  const execution = await deps.skillExecutor.execute({
    interpreter,
    scriptPath,
    args: scriptArgs,
    timeout,
    maxBuffer: SKILL_SCRIPT_MAX_OUTPUT * 2,
    cwd: path.join(skillsDir, args.skill_name),
    signal: options?.signal,
    env: buildSkillEnv(
      args.skill_name,
      path.join(skillsDir, args.skill_name),
    ),
    stdin: args.stdin,
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
      ? `脚本执行超时 (${timeout}ms)`
      : execution.errorMessage;

    log(`${tag} 失败 (${elapsed}ms): ${reason}`);
    if (stderr) {
      log(`${tag} stderr: ${stderr.slice(0, 1000)}`);
    }
    if (stdout) {
      log(`${tag} stdout: ${stdout.slice(0, 500)}`);
    }
    return createToolErrorResult({
      code: execution.killed ? 'SKILL.SCRIPT_TIMEOUT' : 'SKILL.SCRIPT_CRASH',
      kind: execution.killed ? 'timeout' : 'execution',
      retryable: true,
      userSafe: false,
      nextAction: 'retry',
      internalMessage: combinedOutput ? `${reason}\n\n${combinedOutput}` : reason,
      details: {
        skillName: args.skill_name,
        script: action.file,
        elapsed,
        timeout,
        killed: execution.killed,
      },
    });
  }

  log(
    `${tag} 完成 (${elapsed}ms): stdoutLen=${stdout.length} stderrLen=${stderr.length}`,
  );
  if (stdout) {
    log(
      `${tag} stdout: ${stdout.slice(0, 500)}${stdout.length > 500 ? '...(truncated)' : ''}`,
    );
  }
  if (stderr) {
    log(`${tag} stderr: ${stderr.slice(0, 500)}`);
  }
  if (options?.requestScope) {
    markSkillScriptExecuted(options.requestScope, args.skill_name, action.file, {
      loopIteration: options.loopIteration,
      loopRunId: options.loopRunId,
    });
  }
  return { output: combinedOutput || '(脚本无输出)' };
}

export const runSkillScript: ToolSpec = {
  executionMode: 'serial',
  definition: {
    type: 'function',
    function: {
      name: 'run_skill_script',
      description:
        '执行某个 skill 的唯一公开脚本入口（.sh/.py/.js）。通常在 load_skill 加载说明后，按说明中的指引调用。同一个 agent loop 的同一轮里，同一个 skill/script 成功执行后默认不应再次调用。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'skill 目录名（与 load_skill 使用的 skill_name 一致）',
          },
          script: {
            type: 'string',
            description: 'skill manifest 中声明的唯一公开脚本文件名，如 "paipan.js"、"resolve.js"',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '传给脚本的参数列表',
          },
          stdin: {
            type: 'string',
            description: '可选的 stdin 输入内容',
          },
        },
        required: ['skill_name', 'script'],
      },
    },
  },

  prompt: `## run_skill_script — 执行技能脚本

执行指定 skill 的唯一公开脚本入口。这是脚本型 skill 的核心执行工具。

### 使用前提
- **必须先调用 load_skill** 获取 SKILL.md 说明文档。
- 按照 SKILL.md 中的指引确定唯一公开脚本文件名、参数和 stdin 格式。
- 不要自行猜测脚本的用法，严格遵循 SKILL.md 的规范。
- 对 requiresLoad=true 的 skill，运行时会强制校验本轮是否已执行过 load_skill。
- 同一个 agent loop 的同一轮里，同一个 skill/script 在成功执行后默认不要再次调用。若第一次失败且你已补齐参数或修正错误，可以在后续动作里重试。
- 如果用户明确要求多次起卦/多条结果，应分轮推进：先消费当前结果，再决定下一次调用。

### 支持的脚本类型
- **.sh** — Bash 脚本（通过 /bin/bash 执行）
- **.py** — Python 脚本（通过 python3 执行）
- **.js** — Node.js 脚本（通过 node 执行）

其他扩展名的文件不允许执行。

### 参数说明
- **skill_name**：skill 目录名，与 load_skill 使用的一致。
- **script**：manifest 中声明的唯一公开脚本文件名（仅文件名，不含路径），如 "run.sh"、"fetch.py"、"calc.js"。
- **args**（可选）：传递给脚本的命令行参数列表。
- **stdin**（可选）：通过标准输入传递给脚本的内容，常用于传递 JSON 格式的复杂参数。

### 安全限制
- 脚本只能位于对应 skill 目录内，不能包含路径分隔符（防止目录穿越）。
- 脚本执行有超时限制（默认 30 秒，部分 skill 可在 skill.json 中自定义）。
- 输出长度有上限（30000 字符），超出部分会被截断。
- 脚本在沙盒环境中运行，只能访问白名单环境变量。

### 错误处理
- 脚本非零退出码或超时会返回 isError: true。
- stderr 输出会附加在返回结果中，有助于排查问题。`,

  execute: async (args: Record<string, unknown>, options) => {
    return executeRunSkillScript({
      skill_name: args.skill_name as string,
      script: args.script as string,
      args: args.args as string[] | undefined,
      stdin: args.stdin as string | undefined,
    }, {
      signal: options?.signal,
      requestScope: options?.requestScope,
      loopIteration: options?.loopIteration,
      loopRunId: options?.loopRunId,
      skillsDir: options?.skillsDirOverride,
      runtimeDeps: options?.runtimeDeps,
    });
  },
};
