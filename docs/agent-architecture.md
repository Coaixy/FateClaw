# Agent 架构

最近核对：2026-05-26。

这份文档描述当前代码里的 agent 运行架构。当前主链路是宿主进程通过 Redis IPC 调用账号级 agent-runner，agent-runner 每次请求创建 Pi SDK Runtime，由 Pi 负责模型 loop、工具调用和 Skill 文件读取。

核心代码入口：

- `apps/api/src/runtime/resident-agent.ts`
- `apps/api/src/runtime/ipc-worker.ts`
- `apps/api/src/runtime/local-runner.ts`
- `packages/agent-runner/src/daemon.ts`
- `packages/agent-runner/src/engine.ts`
- `packages/agent-runner/src/pi-runtime/`
- `packages/agent-runner/src/text-skill-bundle.ts`

## 总体分层

```text
Web AI Chat / 微信消息代码
        │
        ▼
apps/api 宿主进程
  - 会话、账号、账单、模型配置
  - 构建 history / activeBoardContext
  - 管理 Text Skill Bundle metadata 和权限
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
  - 创建 request-scoped Pi Runtime
  - Pi ResourceLoader 暴露本轮授权 Skill
        │
        ▼
Pi SDK 模型 loop / custom tools / Skill 文件读取
        │
        ▼
宿主落库、结算、返回 Web 或微信
```

宿主和 agent-runner 是两个边界清晰的运行时：

- 宿主负责平台侧事务：用户、账号、会话、消息落库、账单预扣与结算、模型 runtime 解析、Redis IPC、Fastify API、Text Skill Bundle 写入。
- agent-runner 负责 AI 执行：创建 request runtime、调用 Pi SDK、执行 deterministic custom tools、读取授权 Skill 文件、生成 transcript / trace / agentGraph。
- 模型密钥和 provider 是 AI 请求级数据。宿主在 AI Chat / 微信消息入队前解析数据库配置，并通过 `llmRuntime` 快照随 IPC payload 下发；手动排盘请求只携带用户、Skill 和参数，由 Pi deterministic tool 执行。

## Skill 模型

官方 Skill 和用户知识都以 Pi Skill 的方式暴露给模型，但来源不同：

| 类型 | 文件来源 | 暴露方式 | DB 存储 |
| --- | --- | --- | --- |
| 官方排盘/解读 Skill | `skills/official/<dir>/SKILL.md` | Pi ResourceLoader 按用户启用状态过滤后暴露 | `skill_global_config` 和用户启用状态 |
| 用户 Text Skill Bundle | `.fateclaw/text-skills/<owner>/<dir>-<id>/` | 每次请求按权限注入 ResourceLoader | metadata、权限、版本、`bundle_uri`、checksum |

用户 Text Skill Bundle 的典型结构：

```text
SKILL.md
index.md
docs/
  knowledge.md
examples/
notes/
```

私有用户 Skill 不进入 `.pi/skills`、`~/.pi/agent/skills` 或任何全局可扫描目录。`packages/agent-runner/src/text-skill-bundle.ts` 会拒绝这些路径，并只读取 `SKILL.md`、`index.md`、`docs/`、`examples/`、`notes/` 中的 Markdown。

## 宿主请求链路

站内 AI Chat 的主要链路在 `apps/api/src/modules/chat/chat-session-service.ts`：

1. 校验会话归属，并用 Redis `session:processing:{sessionId}` 做会话级并发锁。
2. 写入用户消息。
3. 调 `resolveUserLlmRuntime()` 解析用户当前模型 runtime。
4. 用 `buildStructuredInputForSession()` 构建历史上下文。
5. 如用户选中盘面，追加 `activeBoardContext`。
6. 调 `dispatchAiChatPrompt()`。

`dispatchAiChatPrompt()` 会先确保对应 `web:{userId}` 的 agent-runner 已运行，再调用 `addAccountListener()` 启动宿主侧 outbox 监听，最后通过 `submitAiChatInboxRequest()` 入队。

## Agent Runner 单次请求

`packages/agent-runner/src/daemon.ts` 是唯一常驻入口：

1. `initContext()` 从环境读取 runtimeId 和用户身份。
2. 连接 Redis。
3. `BRPOP ipc:{accountId}:inbox` 等待请求。
4. 解析 `InboxRequest`；AI 请求校验 `llmRuntime`，手动排盘请求校验 `userId`、`skillDir` 和参数对象。
5. 如果请求指定 `outboxQueue`，创建定制 `AgentRuntimeDeps`，把 `messageBus.pushOutbox()` 改到指定队列。
6. AI 请求调 `executeContainerInput()`；手动排盘请求调 `executePiPaipanRequest()`。
7. 把 `ContainerOutput` 包装为 `OutboxResponse` 并 `LPUSH` 到 outbox。

`engine.ts` 负责单次请求的外围逻辑：

- 查询最近一次玄学追问上下文，补齐后续解读需要的盘面/解读材料。
- 拦截固定指令；需要 AI 的指令会改写为普通用户消息继续执行。
- 创建 `createRequestRuntime()`，并把请求交给 `executePiRuntime()`。
- 合并本轮 skill context、transcript、traceEvents、agentGraph、usage 后返回。
- 出错时把内部错误映射为用户可见错误，并保留已有 trace/transcript 便于排障。

## Pi Runtime

`packages/agent-runner/src/pi-runtime/` 是当前 AI 执行主路径：

- `resource-loader.ts`：按请求注入官方 Skill 和授权 Text Skill Bundle。
- `session.ts`：创建 Pi session，配置 provider、prompt、工具和 ResourceLoader。
- `tools.ts`：把 FateClaw 的确定性能力包装为 Pi custom tools。
- `deterministic-tool-catalog.ts`：定义排盘工具名称、脚本、展示名和参数 schema。
- `script-skill-executor.ts`：执行官方排盘脚本并生成 artifact / skillContext。
- `interpret-executor.ts`：执行 `interpret_xuanxue`，并按当前盘面和授权知识注入上下文。
- `skill-read-tool.ts`：让模型按需读取当前授权 Skill Bundle 内的 Markdown 文件。

排盘、解读和用户知识组合都走 Pi tools schema。模型只能调用本轮明确暴露的工具；Skill 文件读取也只作用于当前 ResourceLoader 授权的文件。

## 状态与可观测性

主要真源：

- PostgreSQL：用户、账号、会话、消息、任务、模型配置、技能 metadata、账单、`conversation_logs`。
- 文件系统：用户 Text Skill Bundle 正文。
- Redis：IPC 队列、会话 busy 标记、短期历史/上下文边界等运行态数据。
- `skills/official/`：官方 Skill 的 `SKILL.md` 和确定性脚本。

每次请求完成时，agent-runner 会返回：

- `usage`：模型真实 token 用量。
- `skillContext`：可被后续对话复用的工具/Skill 结果。
- `transcript`：assistant/tool_use/tool_result 事件。
- `traceEvents`：Pi Runtime、工具、错误、进度等结构化事件。
- `agentGraph`：任务、证据和最终回复的图结构。

宿主在 outbox handler 中把 transcript、traceEvents 和 agentGraph 写入 `conversation_logs`。Web 的“查询过程”能力通过消息 metadata 中的 `request_id` 回查这些日志。

## 容易误判的点

- 当前不是每条消息临时起一个 agent，而是每个 runtimeId 复用一个常驻 agent-runner。
- `web:{userId}` 不是账号表记录，只是复用 agent-runner、消息归档和日志分区的运行时键。
- Redis 在这里是 IPC 主通道，不只是缓存。
- 模型 provider、model、secret 是请求级 `llmRuntime` 快照，不从 agent 进程 env 读取。
- 官方 Skill 目录不再依赖 JSON manifest；`SKILL.md` 是 Pi 可读入口，脚本参数 schema 在确定性工具目录中维护。
- 用户知识正文不存 DB；DB 只存控制平面 metadata、权限、版本、安装状态和 bundle 地址。
- 不要在 agent-runner 里找 one-shot stdin/stdout 入口；当前唯一入口是 `daemon.ts`。
