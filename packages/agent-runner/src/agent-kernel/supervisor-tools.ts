import { listArtifacts } from '../artifact-store.js';
import type { MessageBus } from '../deps.js';
import {
  canSendOutbound,
  getRequestId,
  hasProgressKey,
  addProgressKey,
  incrementOutbound,
} from '../request-scope.js';
import type {
  SkillContextEntry,
  ToolErrorInfo,
  ToolRegistrySnapshot,
  ToolResult,
  ToolSpec,
} from '../types.js';
import type { SpecialistExecutionResult, SpecialistName } from './types.js';

/**
 * 根据 specialist 类型返回友好的进度提示文案
 */
function getSpecialistProgressText(specialist: SpecialistName): string {
  switch (specialist) {
    case 'xuanxue-board-agent':
      return '正在排盘';
    case 'xuanxue-interpret-agent':
      return '正在解读';
    case 'general-assistant':
    default:
      return '处理中';
  }
}

function getSpecialistProgressStage(specialist: SpecialistName): string {
  switch (specialist) {
    case 'xuanxue-board-agent':
      return 'board_started';
    case 'xuanxue-interpret-agent':
      return 'interpret_started';
    case 'general-assistant':
    default:
      return 'general_started';
  }
}

function getSpecialistCompletionStage(
  specialist: SpecialistName,
  success: boolean,
): string {
  switch (specialist) {
    case 'xuanxue-board-agent':
      return success ? 'board_completed' : 'board_failed';
    case 'xuanxue-interpret-agent':
      return success ? 'interpret_completed' : 'interpret_failed';
    case 'general-assistant':
    default:
      return success ? 'general_completed' : 'general_failed';
  }
}

function getSpecialistCompletionText(
  specialist: SpecialistName,
  success: boolean,
): string {
  switch (specialist) {
    case 'xuanxue-board-agent':
      return success ? '排盘完成' : '排盘失败';
    case 'xuanxue-interpret-agent':
      return success ? '解读完成' : '解读失败';
    case 'general-assistant':
    default:
      return success ? '处理完成' : '处理失败';
  }
}

/**
 * 玄学排盘类 skill 列表，这些 skill 的输出需要完整返回给 supervisor
 * 以便 LLM 能正确识别 content_source 来源
 */
const XUANXUE_BOARD_SKILLS = [
  'bazi-paipan',
  'ziwei-paipan',
  'iching-paipan',
  'jingzhan-paipan',
  'qimen-paipan',
];

function isXuanxueBoardSkill(producer: string): boolean {
  return XUANXUE_BOARD_SKILLS.includes(producer);
}

function truncateIfNeeded(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...[truncated]';
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function resolveUserSafeTechnicalMessage(
  error: ToolErrorInfo | null | undefined,
): string | null {
  if (!error?.userSafe) return null;
  const message = error.userMessage?.trim();
  return message || null;
}

function resolveBoardUserVisibleReply(args: {
  result: SpecialistExecutionResult;
  specialistCompletedSuccessfully: boolean;
}): string | null {
  if (args.specialistCompletedSuccessfully) return null;

  const technicalMessage = resolveUserSafeTechnicalMessage(
    args.result.technicalFailure,
  );
  if (technicalMessage) return technicalMessage;

  const text = args.result.text?.trim();
  if (!text) return null;
  if (args.result.technicalFailure) return null;
  return text;
}

function buildTechnicalFailureInstruction(error: ToolErrorInfo): string {
  if (error.userSafe && error.userMessage) {
    return 'technicalFailure 含结构化技术细节；对用户优先使用 technicalFailure.userMessage，不要转发 internalMessage。';
  }
  return 'technicalFailure 含内部技术细节；不要直接转发 internalMessage，请改写成面向用户的简短说明。';
}

function createRegistryFromSpecs(specs: ToolSpec[]): ToolRegistrySnapshot {
  const toolMap = new Map(
    specs.map((spec) => [spec.definition.function.name, spec]),
  );

  return {
    toolDefinitions: specs.map((spec) => spec.definition),
    buildToolPrompts: () =>
      specs
        .map((spec) => `### ${spec.definition.function.name}\n${spec.prompt}`)
        .join('\n\n'),
    async executeTool(name, args, options) {
      const spec = toolMap.get(name);
      if (!spec) {
        return {
          output: `未知 supervisor 协议工具: ${name}`,
          isError: true,
        };
      }
      return spec.execute(args, options);
    },
    getExecutionMode(name) {
      return toolMap.get(name)?.executionMode ?? 'serial';
    },
    getProtectedToolNames() {
      return new Set<string>();
    },
  };
}

function makeFinalTool(args: {
  name: 'ask_user' | 'emit_final';
  description: string;
  rewriteText?: (text: string) => string;
}): ToolSpec {
  return {
    executionMode: 'exclusive',
    definition: {
      type: 'function',
      function: {
        name: args.name,
        description: args.description,
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '要返回给用户的文本',
            },
          },
          required: ['text'],
        },
      },
    },
    prompt: `${args.name} 用于结束 supervisor 流程并返回用户可见文本。`,
    async execute(toolArgs): Promise<ToolResult> {
      const rawText = typeof toolArgs.text === 'string' ? toolArgs.text : '';
      return {
        output: args.rewriteText ? args.rewriteText(rawText) : rawText,
        delivery: 'final',
      };
    },
  };
}

export function createSupervisorToolRegistry(args: {
  currentUserMessage: string;
  accountId: string;
  requestScope: import('../request-scope.js').RequestScope;
  messageBus: MessageBus;
  availableSpecialists?: SpecialistName[];
  runSpecialist: (args: {
    specialist: SpecialistName;
    goal: string;
  }) => Promise<SpecialistExecutionResult>;
}): ToolRegistrySnapshot {
  const deliveredSpecialistMessages = new Set<string>();
  const availableSpecialistsList = args.availableSpecialists ?? [
    'general-assistant',
    'xuanxue-board-agent',
    'xuanxue-interpret-agent',
  ];
  const availableSpecialists = new Set(availableSpecialistsList);

  async function emitProgress(
    specialist: SpecialistName,
    phase: 'started' | 'completed',
    success?: boolean,
  ): Promise<void> {
    const stage =
      phase === 'started'
        ? getSpecialistProgressStage(specialist)
        : getSpecialistCompletionStage(specialist, Boolean(success));
    const progressKey = `supervisor_progress:${stage}`;
    if (
      !canSendOutbound(args.requestScope) ||
      hasProgressKey(args.requestScope, progressKey)
    ) {
      return;
    }

    const text =
      phase === 'started'
        ? getSpecialistProgressText(specialist)
        : getSpecialistCompletionText(specialist, Boolean(success));
    await args.messageBus.pushOutbox(args.accountId, {
      type: 'progress',
      accountId: args.accountId,
      requestId: getRequestId(args.requestScope),
      text,
      timestamp: new Date().toISOString(),
      metadata: {
        kind: 'progress',
        workflow: 'supervisor',
        stage,
      },
    });
    addProgressKey(args.requestScope, progressKey);
    incrementOutbound(args.requestScope);
  }

  async function emitSpecialistMessage(
    specialist: SpecialistName,
    text: string,
    stage: string,
    options?: {
      metadata?: Record<string, unknown>;
      skillContext?: SkillContextEntry[];
    },
  ): Promise<boolean> {
    const normalized = text.trim();
    if (!normalized) return false;

    const progressKey = `supervisor_message:${stage}:${normalized.slice(0, 120)}`;
    if (
      !canSendOutbound(args.requestScope) ||
      hasProgressKey(args.requestScope, progressKey)
    ) {
      return false;
    }

    await args.messageBus.pushOutbox(args.accountId, {
      type: 'message',
      accountId: args.accountId,
      requestId: getRequestId(args.requestScope),
      text: normalized,
      timestamp: new Date().toISOString(),
      ...(options?.metadata ? { metadata: options.metadata } : {}),
      ...(options?.skillContext && options.skillContext.length > 0
        ? { skillContext: options.skillContext }
        : {}),
    });
    deliveredSpecialistMessages.add(normalizeComparableText(normalized));
    addProgressKey(args.requestScope, progressKey);
    incrementOutbound(args.requestScope);
    return true;
  }

  function rewriteAlreadyDeliveredFinalText(text: string): string {
    const normalized = normalizeComparableText(text);
    if (normalized && deliveredSpecialistMessages.has(normalized)) {
      return '本轮处理已结束。';
    }
    return text;
  }

  const specs: ToolSpec[] = [
    {
      executionMode: 'parallel',
      definition: {
        type: 'function',
        function: {
          name: 'check_artifacts',
          description:
            '查看本次请求内新生成的证据（不含历史）。历史证据已在对话上下文中，无需此工具查询。用于判断当前请求内哪些 specialist 已执行、产出了什么。',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      prompt: 'check_artifacts 返回本轮请求中已有的 artifact 和历史证据摘要。',
      async execute(): Promise<ToolResult> {
        const requestArtifacts = listArtifacts(args.requestScope);
        return {
          output: JSON.stringify(
            {
              requestArtifacts: requestArtifacts.slice(-8).map((artifact) => ({
                producer: artifact.producer,
                category: artifact.category,
                title: artifact.title,
                outputPreview: artifact.rawOutput.slice(0, 200),
              })),
            },
            null,
            2,
          ),
        };
      },
    },
    {
      executionMode: 'exclusive',
      definition: {
        type: 'function',
        function: {
          name: 'delegate_to_specialist',
          description:
            '把当前任务委派给某个 specialist。适用于通用对话、玄学排盘、玄学解读。',
          parameters: {
            type: 'object',
            properties: {
              specialist: {
                type: 'string',
                enum: availableSpecialistsList,
                description: '要委派的 specialist 名称',
              },
              goal: {
                type: 'string',
                description:
                  '给 specialist 的具体任务说明，包含类别、参数等上下文',
              },
            },
            required: ['specialist', 'goal'],
          },
        },
      },
      prompt:
        'delegate_to_specialist 是 supervisor 的主要工作方式。goal 字段应包含足够的上下文让 specialist 理解任务。',
      async execute(toolArgs): Promise<ToolResult> {
        const specialist = toolArgs.specialist as SpecialistName;
        if (!availableSpecialists.has(specialist)) {
          if (specialist === 'xuanxue-interpret-agent') {
            return {
              output:
                'Free 版可以免费对话和排盘，但暂不支持玄学专业解读。请升级套餐后再解读盘面。',
              delivery: 'final',
            };
          }
          return {
            output: `当前套餐不可使用 ${specialist}。`,
            isError: true,
          };
        }
        const goal =
          typeof toolArgs.goal === 'string' && toolArgs.goal.trim().length > 0
            ? toolArgs.goal.trim()
            : args.currentUserMessage;

        await emitProgress(specialist, 'started');

        const result = await args.runSpecialist({ specialist, goal });
        const specialistCompletedSuccessfully =
          specialist === 'xuanxue-board-agent'
            ? result.success && result.newArtifacts.length > 0
            : result.success;
        await emitProgress(
          specialist,
          'completed',
          specialistCompletedSuccessfully,
        );
        const boardUserVisibleReply =
          specialist === 'xuanxue-board-agent'
            ? resolveBoardUserVisibleReply({
                result,
                specialistCompletedSuccessfully,
              })
            : null;
        const boardReplyDelivered = boardUserVisibleReply
          ? await emitSpecialistMessage(
              specialist,
              boardUserVisibleReply,
              'board_reply',
            )
          : false;

        // xuanxue-board-agent: 有盘面产物时直接透传给用户，避免 supervisor 改写或简化
        if (
          specialist === 'xuanxue-board-agent' &&
          result.success &&
          result.text &&
          result.newArtifacts.length > 0
        ) {
          const boardSkillContext = result.skillContext.filter((entry) =>
            isXuanxueBoardSkill(entry.skill),
          );
          const boardMessageSkillContext =
            boardSkillContext.length > 0
              ? boardSkillContext
              : result.newArtifacts
                  .filter((artifact) => isXuanxueBoardSkill(artifact.producer))
                  .map((artifact) => ({
                    skill: artifact.producer,
                    output: artifact.rawOutput,
                    artifactType: artifact.type,
                    artifactTitle: artifact.title,
                    artifactData: artifact.payload,
                  }));
          const boardSkill =
            boardMessageSkillContext[0]?.skill ??
            result.newArtifacts.find((artifact) =>
              isXuanxueBoardSkill(artifact.producer),
            )?.producer;
          const boardReplyDelivered = await emitSpecialistMessage(
            specialist,
            result.text,
            'board_success_reply',
            {
              metadata: {
                kind: 'board_result',
                workflow: 'supervisor',
                ...(boardSkill ? { board_skill: boardSkill } : {}),
              },
              skillContext: boardMessageSkillContext,
            },
          );
          return {
            output: JSON.stringify({
              specialist,
              success: true,
              boardReady: true,
              ...(boardReplyDelivered
                ? {
                    userVisibleReplyDelivered: true,
                    deliveryInstruction:
                      '排盘结果已完整发送给用户，不要再重复或改写。如用户需要解读，继续委派 interpret specialist；否则用 emit_final 简短收尾即可。',
                  }
                : { reply: result.text }),
              newArtifacts: result.newArtifacts.map((artifact) => ({
                producer: artifact.producer,
                category: artifact.category,
                title: artifact.title,
              })),
            }),
          };
        }

        // 检查是否为重复调用跳过的结果（不应直通）
        const isSkippedResult =
          result.technicalFailure?.code === 'SKILL.DUPLICATE_SAME_LOOP' ||
          result.text?.includes('重复调用已跳过');

        // xuanxue-interpret-agent: 直通输出，解读是最终步骤
        if (
          specialist === 'xuanxue-interpret-agent' &&
          result.success &&
          result.text &&
          !isSkippedResult &&
          !result.technicalFailure
        ) {
          return {
            output: result.text,
            delivery: 'final',
          };
        }

        // general-assistant: 直通输出，通用对话回复是最终步骤
        if (
          specialist === 'general-assistant' &&
          result.success &&
          result.text &&
          !isSkippedResult &&
          !result.technicalFailure
        ) {
          return {
            output: result.text,
            delivery: 'final',
          };
        }

        return {
          output: JSON.stringify(
            {
              specialist,
              success: result.success,
              ...(result.failureReason
                ? { failureReason: result.failureReason }
                : {}),
              ...(result.technicalFailure
                ? {
                    technicalFailure: result.technicalFailure,
                    ...(boardUserVisibleReply && !boardReplyDelivered
                      ? { reply: boardUserVisibleReply }
                      : {}),
                    deliveryInstruction: boardReplyDelivered
                      ? 'reply 已经作为普通中间消息发给用户；不要在最终回复里重复同一段文本。technicalFailure 中的 internalMessage 仅供内部处理，不要转发。'
                      : buildTechnicalFailureInstruction(
                          result.technicalFailure,
                        ),
                  }
                : { reply: boardUserVisibleReply ?? result.text }),
              ...(boardReplyDelivered
                ? {
                    userVisibleReplyDelivered: true,
                    ...(result.technicalFailure
                      ? {}
                      : {
                          deliveryInstruction:
                            'reply 已经作为普通中间消息发给用户；不要在最终回复里重复同一段文本。',
                        }),
                  }
                : {}),
              usage: result.usage,
              newArtifacts: result.newArtifacts.map((artifact) => ({
                producer: artifact.producer,
                category: artifact.category,
                title: artifact.title,
                // 对玄学排盘 skill 包含完整数据，帮助 LLM 正确识别 content_source
                ...(isXuanxueBoardSkill(artifact.producer) && {
                  payload: artifact.payload,
                  rawOutput: truncateIfNeeded(artifact.rawOutput, 8000),
                }),
              })),
              skillContext: result.skillContext.map((entry) => ({
                skill: entry.skill,
                outputPreview: entry.output.slice(0, 160),
              })),
            },
            null,
            2,
          ),
        };
      },
    },
    makeFinalTool({
      name: 'ask_user',
      description: '当还缺关键信息时，结束流程并向用户索取缺失参数。',
      rewriteText: rewriteAlreadyDeliveredFinalText,
    }),
    makeFinalTool({
      name: 'emit_final',
      description: '当已经完成任务时，结束流程并返回最终答复。',
      rewriteText: rewriteAlreadyDeliveredFinalText,
    }),
  ];

  return createRegistryFromSpecs(specs);
}
