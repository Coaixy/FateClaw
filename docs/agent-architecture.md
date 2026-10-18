# Agent 架构

Last checked: 2026-10-17.

这份文档描述当前代码里的 agent 运行架构。当前主链路是宿主进程通过 Redis IPC 调用账号级 agent-runtime，agent-runtime 每次请求创建 Pi SDK Runtime，由 Pi 负责模型 loop、用户知识读取和最终回复。系统排盘由 Web/API 侧的确定性运行包执行。

核心代码入口：

- `apps/api/src/runtime/resident-agent.ts`
- `apps/api/src/runtime/ipc-worker.ts`
- `apps/api/src/runtime/local-runner.ts`
- `apps/agent-runtime/src/daemon.ts`
- `apps/agent-runtime/src/request-boundary.ts`
- `apps/agent-runtime/src/pi-runtime/`
- `apps/agent-runtime/src/skill-content-cache.ts`

## 总体分层

```text
Web AI Chat / 微信消息代码
        │
        ▼
apps/api 宿主进程
  - 会话、账号、账单、模型配置
  - 构建 history / activeBoardContext
  - 调用系统排盘运行包生成盘面 artifact
  - 管理 Text Skill Bundle metadata 和权限
  - Redis IPC 入队、监听 outbox
        │
        ▼
Redis IPC
  ipc:{runtimeId}:inbox:member
  ipc:{runtimeId}:inbox
  ipc:{runtimeId}:outbox
  ipc:{runtimeId}:ai-chat:outbox
  ipc:{runtimeId}:cancel
        │
        ▼
账号级 agent-runtime 常驻进程
  - daemon BRPOP inbox
  - request-boundary 处理单次请求
  - 创建 request-scoped Pi Runtime
  - Pi ResourceLoader 暴露本轮授权 Text Skill Bundle
        │
        ▼
Pi SDK 模型 loop / 授权 Skill 文件读取
        │
        ▼
宿主落库、结算、返回 Web 或微信
```

宿主和 agent-runtime 是两个边界清晰的运行时：

- 宿主负责平台侧事务：用户、账号、会话、消息落库、账单预扣与结算、模型 runtime 解析、Redis IPC、Fastify API、Text Skill Bundle 写入，以及系统排盘 runner 调用。
- agent-runtime 负责 AI 执行：创建 request runtime、调用 Pi SDK、读取授权 Skill 文件、生成 transcript / trace / agentGraph。
- 模型密钥和 provider 是 AI 请求级数据。宿主在 AI Chat / 微信消息入队前解析数据库配置，并通过 `llmRuntime` 快照随 IPC payload 下发；手动排盘请求由 API 侧调用系统排盘运行包，不需要模型 runtime。

## 本地 agent-runtime 生命周期

当前本地部署不再依赖 Docker 运行 agent-runtime。宿主通过 `apps/api/src/runtime/local-runner.ts` 用子进程启动 `apps/agent-runtime`：

- 开发环境默认优先源码入口 `src/daemon.ts`，生产或 `LOCAL_AGENT_ENTRY_MODE=dist` 使用 `dist/daemon.js`。
- 每个 runtimeId 对应一个常驻子进程；站内 AI Chat runtimeId 为 `web:{userId}`，微信场景为账号 ID。
- 子进程 env 由 `apps/api/src/runtime/agent-env.ts` 统一构建，只注入身份、PostgreSQL、Redis、项目根、Pi session 目录等运行依赖，不注入全局模型密钥。
- The current local policy permits four resident account processes. At capacity, the host retires the oldest idle runtime and counts it until actual exit.
- Idle runtimes retire after ten minutes. An admitted execution retains its exact child lease until final response, cancellation or timeout.
- Linux 启动时会清理上一任宿主异常退出后留下的本项目孤儿 agent-runtime，避免旧进程继续消费 Redis 队列。

## Skill 与排盘模型

当前只有用户 Text Skill Bundle 以 Pi Skill 方式暴露给模型。系统排盘不再是 Pi Skill，而是 Web/API 侧可控的确定性业务资源：

| 类型 | 文件来源 | 暴露方式 | DB 存储 |
| --- | --- | --- | --- |
| 系统排盘 runner | `apps/api/src/modules/chat/paipan-registry.ts` + `paipan-runners/*.ts` | API `/api/paipan/*` 直接调用，结果作为盘面 artifact 进入会话 | `skill_global_config` 和用户启用状态（兼容旧命名） |
| User Text Skill Bundle | Rebuildable process-owned snapshots in `.fateclaw/text-skills/cache-v1/` | Authorized per request through ResourceLoader | Immutable `skill_content_revisions`, a current revision pointer, metadata, and permissions |

PostgreSQL owns user skill content. API saves atomically insert an immutable revision and update its skill pointer after checking the editor's base revision. Agent-runtime authorizes and fixes a revision for each request, then restores it with the shared content protocol and process-owned local cache. Active snapshot leases are released when session creation or execution finishes or fails. Cache retention never deletes active snapshots. Legacy filesystem reads are confined to the API's independent import module; ordinary skill reads use PostgreSQL. See [Skill content architecture](skill-content-architecture.md).

用户 Text Skill Bundle 的典型结构：

```text
SKILL.md
index.md
docs/
  knowledge.md
examples/
notes/
```

私有用户 Skill 不进入 `.pi/skills`、`~/.pi/agent/skills` 或任何全局可扫描目录。`apps/agent-runtime/src/skill-content-cache.ts` 会拒绝这些路径，并只读取 `SKILL.md`、`index.md`、`docs/`、`examples/`、`notes/` 中的 Markdown。

## 宿主请求链路

站内 AI Chat 的主要链路在 `apps/api/src/modules/chat/chat-session-service.ts`：

1. 校验会话归属，并用 Redis `session:processing:{sessionId}` 做会话级并发锁。
2. 写入用户消息。
3. `resolveUserLlmRuntime()` captures the official model pool, common prices and thinking level; legacy user selections are ignored. Model-call routing, failover and shared circuit state are described in [Official model pool](official-model-pool.md).
4. 用 `buildStructuredInputForSession()` 构建历史上下文。
5. 如用户选中盘面，追加 `activeBoardContext`。
6. 调 `dispatchAiChatPrompt()`。

`dispatchAiChatPrompt()` 会先确保对应 `web:{userId}` 的 agent-runtime 已运行，再调用 `addAccountListener()` 启动宿主侧 outbox 监听，最后通过 `submitAiChatInboxRequest()` 入队。

站内 AI Chat 默认面向前端异步返回：HTTP `POST /api/chat-sessions/s/:sessionId/messages` 入队成功后通常返回 `accepted: true` 和 `request_id`，最终回复由 `ipc-ai-chat-outbox-handler.ts` 处理 `ipc:{runtimeId}:ai-chat:outbox` 后落库。Web 通过 `POST /api/chat-sessions/s/:sessionId/stream-ticket` 换取短期一次性票据，再连接 `/api/chat-sessions/s/:sessionId/stream` WebSocket；服务端用 Redis pub/sub 把 Pi session 事件、进度、最终回复和错误推给当前会话。

微信/居民 agent 走默认 `ipc:{runtimeId}:outbox`，由 `ipc-outbox-handler.ts` 处理并可按 `autoDeliver` 发送到 iLink。AI Chat 专属 outbox 永远不发微信。

## 并发、取消与结算

宿主在请求进入 agent-runtime 前后维护几类运行态保护：

- 会话级忙碌锁：`session:processing:{sessionId}` 防止同一 AI Chat 会话并发多轮；只有当前 requestId 才能续期或释放；TTL 由超时链派生（API 超时 + 5 分钟）。
- 全局 agent 并发槽：`agent:concurrency:active` 限制全站同时进入模型 loop 的请求数；等待队列为 ZSET（`agent:concurrency:waitq:member` / `waitq:normal`，score=入队时间），配合心跳哈希 `agent:concurrency:wait:heartbeat`——等待者每次轮询报活，任何存活等待者的 Lua 调用都会原子驱逐心跳超时（15 秒）的死亡队头，进程崩溃不会永久毒化队列；释放槽位时优先会员队列。
- 本地 agent 租约：请求持有 runtime 子进程，最终响应、取消、出错或超时时释放，之后按 idle TTL 回收。
- 监听器回收：站内 `web:{userId}` 的 outbox 监听是懒创建的，空闲 10 分钟且无在途请求时自动退出释放 Redis 连接；微信账号监听常驻（pinned）。回收/进程重启后迟到的 outbox 消息由 `inbox-stall-sweeper` 的 outbox 巡检代为消费落库（无主阈值 3 分钟），不会丢失。
- 取消队列：前端中断会向 `ipc:{runtimeId}:cancel` 写入 cancel payload；agent-runtime 在处理当前请求时轮询该队列并调用 Pi session `abort()`。
- 账务预留与结算：入队前按 `llmRuntime` 预留；最终响应「先落库交付、再结算扣费」——落库失败则预留保持 pending 由 billing-sweeper 按对话日志补收，杜绝"已扣费但用户收不到消息"；结算完成后把扣费金额回填进最终消息 metadata。
- 超时链：全部请求链路超时由 `apps/api/src/shared/timeout-chain.ts` 单一来源派生（daemon 硬超时 8 分钟 < inbox 清理阈值 < API 超时 30 分钟 < 会话锁 TTL），daemon 侧的值由宿主 spawn 时经 env 注入，违例配置启动即报错。
- 存活心跳：daemon 每 10 秒写 `agent:heartbeat:{accountId}`（TTL 30 秒），优雅退出时主动删除；巡检任务对"inbox 有堆积但心跳缺失"的账号立即发运维告警（`ALERT_WEBHOOK_URL`，可选），无需等到清理阈值。

## Agent Runtime 单次请求

`apps/agent-runtime/src/daemon.ts` 是唯一常驻入口：

1. `initContext()` 从环境读取 runtimeId 和用户身份。
2. 连接 Redis。
3. `BRPOP ipc:{accountId}:inbox` 等待请求。
4. 解析 `InboxRequest`；AI 请求校验 `llmRuntime`。
5. 如果请求指定 `outboxQueue`，创建定制 `AgentRuntimeDeps`，把 `messageBus.pushOutbox()` 改到指定队列。
6. AI 请求调 `executeContainerInput()`。
7. 把 `ContainerOutput` 包装为 `OutboxResponse` 并 `LPUSH` 到 outbox。

`request-boundary.ts` 负责单次请求的外围逻辑：

- 创建 `createRequestRuntime()`，并把请求交给 `executePiRuntime()`。
- 合并本轮 skill context、transcript、traceEvents、agentGraph、usage 后返回。
- 出错时把内部错误映射为用户可见错误，并保留已有 trace/transcript 便于排障。

## Pi Runtime

`apps/agent-runtime/src/pi-runtime/` 是当前 AI 执行主路径：

- `resource-loader.ts`：按请求注入授权 Text Skill Bundle。
- `session.ts`：创建 Pi session，配置 provider、prompt、工具和 ResourceLoader。
- `skill-read-tool.ts`：让模型按需读取当前授权 Skill Bundle 内的 Markdown 文件。

排盘先由 API 侧生成结构化 artifact；Pi Runtime 只基于本轮盘面、用户问题和授权知识推理。Skill 文件读取只作用于当前 ResourceLoader 授权的用户知识文件。

Chart-specific prompts live in `apps/agent-runtime/src/pi-runtime/prompts/` and
attach to the matching board in the context manifest. The Jingzhan prompt applies
to official and user-pasted Jingzhan boards and prohibits Liuyao interpretation
methods. It is loaded only with a Jingzhan board.

Pi session 创建时内置工具被禁用，FateClaw 只显式注入自己的 custom tools，例如授权 Markdown 读取、Soul 读取/编辑和与当前会话盘面相关的上下文工具。模型不能假设存在全局本地 Skill 或排盘执行工具。

## Bounded Skill search and runtime recovery

- Each `grep` invocation runs scope resolution, Markdown discovery, regex compilation
  and line matching in a disposable worker. The daemon enforces a two-second budget
  for the entire invocation and terminates the worker on timeout or cancellation.
- Workers receive only search parameters, authorized Skill names and directories,
  and the request's cached Markdown file lists. They have an empty environment and
  do not load the daemon, database clients or model credentials.
- Search keeps JavaScript regex semantics, defaults to regex mode, and falls back
  to literal matching for invalid patterns. Complete lines are matched; only result
  previews are shortened. The eight-MiB file limit and result count limit remain.
- Timeout, cancellation and worker failure return explicit tool errors with an
  inexact result count. File discovery is committed to the request cache only after
  successful worker exit. Source workers use Node 24 type stripping; TypeScript
  rewrites relative `.ts` imports for the compiled `.js` workers.
- The host checks each ready child's heartbeat after a 30-second startup grace,
  then every ten seconds. Two consecutive successful Redis reads reporting a
  missing key retire the child even if it is busy. A Redis error or a live heartbeat
  resets that count. SIGTERM is followed by SIGKILL after ten seconds if necessary.
- A replacement for the same account waits for the retired child to exit. Local
  request leases belong to exact child records and release once, so delayed cleanup
  cannot change a replacement's busy count. Existing exit handling and durable
  recovery terminate interrupted requests without automatically replaying execution.

## 状态与可观测性

主要真源：

- PostgreSQL：用户、账号、会话、消息、任务、模型配置、技能 metadata、账单、`conversation_logs` 和 `conversation_log_payloads`。
- Filesystem: rebuildable authorized Skill revision snapshots, Pi session files and unsent result spools. PostgreSQL owns Skill content.
- Redis：IPC 队列、会话 busy 标记、短期历史/上下文边界等运行态数据。
- `apps/api/src/modules/chat/paipan-registry.ts`：系统排盘目录清单、参数 schema 和 runner 绑定。
- `apps/api/src/modules/chat/paipan-runners/`：系统排盘 TypeScript 确定性实现。

每次请求完成时，agent-runtime 会返回：

- `usage`：模型真实 token 用量。
- `skillContext`：可被后续对话复用的工具/Skill 结果。
- `transcript`：assistant/tool_use/tool_result 事件。
- `traceEvents`：Pi Runtime、工具、错误、进度等结构化事件。
- `agentGraph`：任务、证据和最终回复的图结构。

宿主在 outbox handler 中把 usage、模型、事件计数和摘要写入 `conversation_logs`，把 transcript、traceEvents 和 agentGraph 正文写入 `conversation_log_payloads`。Web 的“查询过程”能力通过消息 metadata 中的 `request_id` 回查这些日志。

## Runtime scheduling and recovery frames

Capacity scheduling is owned by `apps/api/src/runtime/agent-scheduler.ts`.
A Redis account lease precedes local startup and the global execution gate.
Waiting requests retain durable admission and their original deadline without
occupying global slots. Member priority applies among runnable accounts. Release
atomically removes account/global ownership and publishes a capacity notification;
local wakeups and finite reconciliation bound recovery when notifications fail.
Queued requests are not failed when an earlier execution's child exits.

Pi session frame data is owned by `packages/contracts/src/agent/` and persisted by
`pi-session-frames-repository.ts` in the result delivery transaction. Full
checkpoints occur every sixteen frames and after compaction changes the message
prefix. Lightweight traces remain independent of snapshot storage. See
[performance and reliability](performance-and-reliability.md) for rollout, resource
preparation, timing definitions, retention and validation boundaries.

## Runtime transport and stream batching

- Each agent daemon owns two Redis connections. The inbox connection is used only
  for blocking reads; heartbeat, cancellation, stream publication and outbox writes
  use the command connection. The ready signal is emitted only after both connect.
- Shutdown disconnects the blocking connection directly, since `QUIT` would wait
  behind `BRPOP`. Command connection shutdown waits at most five seconds before
  disconnecting. This bounds Redis cleanup, not the entire daemon drain sequence.
- Each Pi request coalesces consecutive assistant or thinking text updates within
  a 50 ms window. Full snapshots remain available to reconnecting clients, and
  merged deltas contain all text added within the window. A stream type change,
  turn change, replacement snapshot, or non-text event flushes pending text first.
- Request completion, cancellation and errors flush pending text and clear the
  batching timer through the Pi session cleanup path. Publication remains
  best-effort; persisted final messages remain the delivery source of truth.

## 容易误判的点

- 当前不是每条消息临时起一个 agent，而是每个 runtimeId 复用一个常驻 agent-runtime。
- `web:{userId}` 不是账号表记录，只是复用 agent-runtime、消息归档和日志分区的运行时键。
- Redis 在这里是 IPC 主通道，不只是缓存。
- AI Chat 的 HTTP 发送接口成功并不等于最终回复已生成；最终消息由 ai-chat outbox 异步落库并经 WebSocket 推送。
- 模型 provider、model、secret 是请求级 `llmRuntime` 快照，不从 agent 进程 env 读取。
- 系统排盘不再使用旧版说明文件或独立脚本目录；参数 schema 和 runner 绑定在 `apps/api/src/modules/chat/paipan-registry.ts` 中维护。
- 用户知识正文不存 DB；DB 只存控制平面 metadata、权限、版本、安装状态和 bundle 地址。
- 不要在 agent-runtime 里找 one-shot stdin/stdout 入口；当前唯一入口是 `daemon.ts`。

## Reliability contract

See [performance and reliability](performance-and-reliability.md) for the durable
admission state machine, result acknowledgement, recovery, bounded queues and
Pi 0.86.0 deployment contract.
