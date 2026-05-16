# Agent 架构

最近核对：2026-05-08。

这份文档描述当前代码里的 agent 运行架构，不描述早期 changelog 中的一次性容器或文件型 IPC 设计。涉及的核心代码入口：

- `apps/api/src/runtime/resident-agent.ts`
- `apps/api/src/runtime/ipc-worker.ts`
- `apps/api/src/runtime/local-runner.ts`
- `packages/agent-runner/src/daemon.ts`
- `packages/agent-runner/src/engine.ts`
- `packages/agent-runner/src/agent-kernel/`
- `packages/agent-runner/src/base-loop.ts`

## 总体分层

```text
Web AI Chat / 微信消息代码
        │
        ▼
apps/api 宿主进程
  - 会话、账号、账单、模型配置
  - 构建 history / activeBoardContext
  - Redis IPC 入队、监听 outbox
        │
        ▼
Redis IPC
  ipc:{runtimeId}:inbox
  ipc:{runtimeId}:outbox
  ipc:{runtimeId}:ai-chat:outbox
  ipc:{runtimeId}:tasks
        │
        ▼
账号级 agent-runner 常驻进程
  - daemon BRPOP inbox
  - engine 处理单次请求
  - agent-kernel 做 supervisor / specialist 编排
  - base-loop 调模型与工具
        │
        ▼
模型 provider / tools / skills / DB / Redis
        │
        ▼
宿主落库、结算、返回 Web 或微信
```

宿主和 agent-runner 是两个边界清晰的运行时：

- 宿主负责平台侧事务：用户、账号、会话、消息落库、账单预扣与结算、模型 runtime 解析、Redis IPC、Fastify API。
- agent-runner 负责 AI 执行：构建 prompt、调用模型、执行工具、加载 Skill、生成 transcript / trace / agentGraph。
- 模型密钥和 provider 不再依赖 agent 进程环境变量；宿主在每个请求入队前解析数据库配置，并通过 `llmRuntime` 快照随 IPC payload 下发。

## 运行时身份

`runtimeId` 在队列和日志里复用 `accountId` 字段，但有两种来源：

- 微信账号：真实账号 ID，来自 `accounts` 表。
- 站内 AI Chat：`web:{userId}`，由 `apps/api/src/modules/chat/web-chat-runtime.ts` 生成，不写入 `accounts` 表。

`local-runner.ts` 按 runtimeId 维护一个本地子进程。`ensureLocalAgentRunning()` 会复用已存在进程，并用 `startingAgents` 合并并发启动，避免同一个 runtimeId 被重复 `spawn`。

agent 进程环境由 `apps/api/src/runtime/agent-env.ts` 构建，只注入身份、时区、Redis、Database、PATH/HOME/NODE_ENV 等运行必需字段。模型配置走请求级 `llmRuntime`，不是进程级 env。

## 当前入口状态

`apps/api/src/app/index.ts` 当前启动顺序是：

1. 初始化 PostgreSQL。
2. 扫描官方 Skill 并写入配置。
3. 连接 Redis。
4. 调用 `startIpcWorker([])`。
5. 启动 retention worker 和 Fastify API。

微信设备 listener、poller 在当前入口里暂时关闭；`activateAccount()` 也只记录日志并跳过热激活。`apps/api/src/modules/chat/message-handler.ts` 里的微信消息处理链路仍保留，但当前默认运行路径以站内 AI Chat 为主。

## 宿主请求链路

站内 AI Chat 的主要链路在 `apps/api/src/modules/chat/chat-session-service.ts`：

1. 校验会话归属，并用 Redis `session:processing:{sessionId}` 做会话级并发锁。
2. 写入用户消息。
3. 调 `resolveUserLlmRuntime()` 解析用户当前模型 runtime。
4. 用 `buildStructuredInputForSession()` 构建历史上下文。
5. 如用户选中盘面，追加 `activeBoardContext`。
6. 调 `dispatchAiChatPrompt()`。

`dispatchAiChatPrompt()` 会先确保对应 `web:{userId}` 的 agent-runner 已运行，再调用 `addAccountListener()` 启动宿主侧 outbox 监听，最后通过 `submitAiChatInboxRequest()` 入队。

入队前宿主会：

- 解析 owner user。
- 将 `EffectiveLlmRuntimeConfig` 转为 `LlmRuntimeSnapshot`。
- 为 metered runtime 预扣点数。
- 设置请求超时。
- 写入 `ipc:{runtimeId}:inbox`。
- 指定 `outboxQueue=ipc:{runtimeId}:ai-chat:outbox`，让 AI Chat 响应和中间消息走隔离队列。

普通 `dispatchResidentPrompt()` 使用默认 outbox，但当前 `submitInboxRequest()` 对 `autoDeliver=true` 会直接拒绝，因此不要把微信自动发送链路当成当前默认可用路径。

## Redis IPC 契约

当前 Redis 队列是逻辑队列，不是旧文档里的目录结构：

| 队列 | 方向 | 用途 |
| --- | --- | --- |
| `ipc:{runtimeId}:inbox` | host -> agent | 单次 chat/task 请求 |
| `ipc:{runtimeId}:outbox` | agent -> host | 默认最终响应、中间消息、进度 |
| `ipc:{runtimeId}:ai-chat:outbox` | agent -> host | 站内 AI Chat 专属响应队列 |
| `ipc:{runtimeId}:tasks` | agent -> host | 提醒任务管理等任务变更 |

`ipc-worker.ts` 维护 pending request map。最终 `response` 回来后，宿主会清除超时器、释放会话 busy 标记、落库 `conversation_logs`、记录 token、结算账单，并 resolve 原始请求。

## Agent Runner 单次请求

`packages/agent-runner/src/daemon.ts` 是唯一常驻入口：

1. `initContext()` 从环境读取 runtimeId 和用户身份。
2. 连接 Redis。
3. `BRPOP ipc:{accountId}:inbox` 等待请求。
4. 解析 `InboxRequest`，校验 `llmRuntime`。
5. 如果请求指定 `outboxQueue`，创建定制 `AgentRuntimeDeps`，把 `messageBus.pushOutbox()` 改到指定队列。
6. 调 `executeContainerInput()`。
7. 把 `ContainerOutput` 包装为 `OutboxResponse` 并 `LPUSH` 到 outbox。

`engine.ts` 负责单次请求的外围逻辑：

- 查询最近一次玄学追问上下文，补齐后续解读需要的盘面/解读材料。
- 拦截固定指令；需要 AI 的指令会改写为普通用户消息继续执行。
- 建立 request runtime 和 tool registry。
- 调 `executeAgentKernel()`。
- 合并本轮 skill context、transcript、traceEvents、agentGraph、usage 后返回。
- 出错时把内部错误映射为用户可见错误，并保留已有 trace/transcript 便于排障。

## Kernel 编排

`packages/agent-runner/src/agent-kernel/` 是当前 agent 架构的核心。它不是单个大 prompt，而是 supervisor + specialist 的图式调度。

### Capability Catalog

`capabilities.ts` 从基础 tool registry 和当前用户启用的官方 Skill 生成能力目录。能力按 specialist 过滤：

- `general-assistant`：日常对话、记忆、提醒、时间/历法、通用工具、技能管理。
- `xuanxue-board-agent`：官方排盘 Skill、`load_skill`、`run_skill_script`、必要的时间和历史工具。
- `xuanxue-interpret-agent`：`interpret_xuanxue`、`list_knowledge_sections`、`read_knowledge_section`。

站内 AI Chat 的 `web:{userId}` 运行时会从 general 能力中移除提醒相关工具，避免 Web Chat 管理微信 BOT 定时任务。

### 快路径

`executeAgentKernel()` 在进入 supervisor 前有两条确定性快路径：

- `inputKind=user_pasted_board` 且材料有效：直接委派 `xuanxue-interpret-agent`，不让 supervisor 重新解析外部盘面。
- `activeBoardContext` 存在：直接委派 `xuanxue-interpret-agent` 解读用户当前明确选中的盘面。

这两条路径是为了避免模型把用户自贴盘面误当成排盘参数，或者在用户已选中盘面时重新排盘。

### Supervisor

没有命中快路径时，kernel 启动 supervisor loop。Supervisor 的工具不是全部业务工具，而是一组协议工具：

- `check_artifacts`：查看本轮新证据。
- `delegate_to_specialist`：委派 specialist。
- `ask_user`：缺关键参数时结束本轮并追问。
- `emit_final`：任务完成时结束本轮。

Supervisor 自己不做领域工作；排盘、解读、通用工具都必须通过 specialist 完成。`delegate_to_specialist` 会发送进度消息，并对排盘和解读结果做直通策略：排盘产物可作为中间消息完整发送，解读和通用回复可直接成为最终回复。

### Specialist

`specialists.ts` 为每个 specialist 构建专用 system prompt 和过滤后的 tool registry。Specialist 只接收最近 6 条历史，并通过 delegation message 获取 supervisor 目标、本轮用户消息和当前 artifact 摘要，避免每次委派都重传完整上下文。

Specialist 执行完后返回：

- 文本结果。
- token usage。
- 本轮 skill context。
- 新 artifact。
- 最近一次结构化工具错误。

Kernel 汇总这些信息，并用 `graph.ts` 生成 `AgentTaskGraph`，记录 root task、specialist task、history/artifact/final reply evidence 以及边关系。

## 模型循环与 Provider

`base-loop.ts` 是统一工具循环，provider 差异由 adapter 注入。`provider-factory.ts` 支持：

- `openai-compatible` -> `OpenAIAdapter`
- `openai-response` -> `OpenAIResponsesAdapter`
- `anthropic` -> `AnthropicAdapter`
- `gemini` -> `GeminiAdapter`

模型循环的稳定协议是：

1. 每轮调用模型时附带当前可用工具和内置 `final_reply`。
2. 模型调用普通工具时，runtime 执行工具并把结果回灌给模型。
3. 模型调用 `final_reply` 或某个工具返回 `delivery: "final"` 时结束循环。
4. 模型只输出裸文本时视为协议违例，runtime 会注入修复指令；超过修复次数后才降级返回裸文本。

循环还负责：

- 上下文 token 粗估、校准和截断。
- 429 / 上下文过长错误的可恢复处理。
- `load_skill` 与 skill 工具的依赖重排。
- 按工具声明做 serial / parallel 批次执行。
- 汇总 usage、skillContext、trace 和 transcript。

## Tool 与 Skill

基础 tool registry 在 `packages/agent-runner/src/tools/registry.ts`，包括：

- conversation：`send_message`
- memory：`read_memory` / `write_memory`
- reminder：`schedule_reminder` / `list_reminders` / `manage_reminder`
- skill：`load_skill` / `run_skill_script` / `manage_skill`
- xuanxue knowledge：`list_knowledge_sections` / `read_knowledge_section`
- utility：时间、历法、随机数、历史召回等工具

官方 Skill 来自 `skills/official/` 的 manifest。启动时宿主会 seed 到数据库；运行时 `CapabilityCatalog` 还会结合数据库中的启用状态过滤，避免 prompt 暴露未启用能力。

排盘类官方 Skill 会被封装为 composite tool。`run_skill_script` 和 composite tool 属于 protected tools，adapter 会尽量避免模型端把参数 schema 放宽成不安全调用。

## 状态与可观测性

主要真源：

- PostgreSQL：用户、账号、会话、消息、任务、模型配置、技能配置、账单、`conversation_logs`。
- Redis：IPC 队列、会话 busy 标记、短期历史/上下文边界等运行态数据。
- `skills/official/`：官方 Skill 文件来源。

每次请求完成时，agent-runner 会返回：

- `usage`：模型真实 token 用量。
- `skillContext`：可被后续对话复用的工具/Skill 结果。
- `transcript`：assistant/tool_use/tool_result 事件。
- `traceEvents`：loop、工具、错误、进度等结构化事件。
- `agentGraph`：任务、证据和最终回复的图结构。

宿主在 outbox handler 中把 transcript、traceEvents 和 agentGraph 写入 `conversation_logs`。Web 的“查询过程”能力通过消息 metadata 中的 `request_id` 回查这些日志。

## 容易误判的点

- 当前不是每条消息临时起一个 agent，而是每个 runtimeId 复用一个常驻 agent-runner。
- `web:{userId}` 不是账号表记录，只是复用 agent-runner、消息归档和日志分区的运行时键。
- Redis 在这里是 IPC 主通道，不只是缓存。
- 模型 provider、model、secret 是请求级 `llmRuntime` 快照，不从 agent 进程 env 读取。
- `changelog/2026-03-23-resident-agent-ipc-runtime.md` 里的 `data/ipc/{account_id}/` 是旧说明；当前代码使用 Redis list key。
- 不要在 agent-runner 里找 one-shot stdin/stdout 入口；当前唯一入口是 `daemon.ts`。
