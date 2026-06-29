# AGENT.md

这个文件给下次进入仓库的代理或协作者使用。目标不是介绍产品，而是尽快建立“先看哪里、谁负责什么、哪些文档可能过时”的认知。

## 一句话理解

这是一个“宿主编排 + 账号级常驻 agent-runtime + Web 控台”的玄学 AI Chat、手动排盘和 Text Skill Bundle 系统。

- 宿主在 `apps/api/src/`
- agent-runtime 在 `apps/agent-runtime/`
- 前端在 `apps/web/`
- 管理后台在 `apps/admin/`
- 系统排盘实现内置在 `apps/api/src/modules/chat/paipan-runners/`

## 建议阅读顺序

第一次接手时按这个顺序读：

1. `README.md`
2. `docs/agent-architecture.md`
3. `apps/api/src/app/index.ts`
4. `apps/api/src/interfaces/http/server.ts`
5. `apps/api/src/runtime/resident-agent.ts`
6. `apps/api/src/runtime/local-runner.ts`
7. `apps/api/src/runtime/ipc-worker.ts`
8. `apps/agent-runtime/src/daemon.ts`
9. `apps/agent-runtime/src/request-boundary.ts`
10. `apps/agent-runtime/src/pi-runtime/index.ts`
11. `apps/agent-runtime/src/pi-runtime/resource-loader.ts`
12. `apps/agent-runtime/src/text-skill-bundle.ts`
13. `apps/api/src/infrastructure/db.ts`

如果任务是前端改动，再补读：

1. `apps/web/app/layout.tsx`
2. `apps/web/app/page.tsx`
3. `apps/web/features/auth/api.ts`
4. `apps/web/features/auth/hooks/use-auth.ts`
5. `apps/web/AGENT.md`

如果任务是 API 改动，再补读：

1. `apps/api/src/interfaces/http/AGENT.md`
2. `apps/api/src/interfaces/http/server.ts`
3. 对应 `apps/api/src/interfaces/http/*-routes.ts`
4. `apps/api/src/infrastructure/db.ts`

## 系统边界

### 宿主 `apps/api/src/`

宿主负责：

- 初始化 PostgreSQL 和 Redis
- 启动 Fastify API
- 通过 `apps/api/src/runtime/local-runner.ts` 以子进程方式拉起 agent-runtime（`node dist/daemon.js`）
- 处理 iLink 长轮询代码路径
- 通过 Redis IPC 给账号 agent 投递请求
- 持久化消息、日志、技能配置等

优先入口：

- `apps/api/src/app/index.ts`
- `apps/api/src/app/dev-api.ts`
- `apps/api/src/modules/chat/message-handler.ts`
- `apps/api/src/runtime/poller.ts`

### Agent Runtime `apps/agent-runtime/`

agent-runtime 负责：

- 读取宿主注入的环境变量
- 为单个账号常驻监听 inbox
- 创建 request-scoped Pi Runtime
- 通过 Pi SDK 调用模型 provider
- 暴露本轮允许访问的用户 Text Skill Bundle
- 回传 usage、transcript、trace 和 agent graph
- 返回 transcript、usage、routing、trace 等结构化结果

优先入口：

- `apps/agent-runtime/src/daemon.ts`
- `apps/agent-runtime/src/request-boundary.ts`
- `apps/agent-runtime/src/pi-runtime/index.ts`
- `apps/agent-runtime/src/pi-runtime/session.ts`
- `apps/agent-runtime/src/pi-runtime/resource-loader.ts`
- `apps/agent-runtime/src/pi-runtime/tools.ts`
- `apps/agent-runtime/src/text-skill-bundle.ts`

### Web `apps/web/`

Web 负责：

- 用户登录注册
- 账号管理和 Soul 编辑
- AI Chat、手动排盘、自贴盘面、简易模式入口
- 技能市场、创作者 Studio、钱包、设置

开发态独立运行在 `3001`，生产态是静态导出后由宿主托管。

### Admin `apps/admin/`

Admin 是独立管理后台静态站点，负责：

- 管理登录和权限范围识别
- 用户、消息、会话、日志和 Skill 检索
- 官方模型 Provider、运行时、充值、奖励、会员、公告、workflow preset 配置

开发态独立运行在 `3002`，生产态建议独立部署到 admin 域名；安全边界仍在后端 `/api/admin/*` 的 `X-Admin-Key` 校验和反向代理入口保护。

## 关键认知

### 1. 这是按账号拆分的常驻 agent 架构

不要把它理解成“每条消息临时起一个 agent”。宿主会为运行时 ID 维持常驻 agent-runtime，站内 AI Chat 使用 `web:{userId}`，微信场景使用账号 ID；`dispatchAiChatPrompt()` / `dispatchResidentPrompt()` 只是把请求投递进去。

### 2. Redis 是 IPC，不只是缓存

这里 Redis 的重要用途是宿主和 agent 之间的请求/响应/任务队列，不只是辅助缓存。

### 3. Postgres 是主要真源

排查业务问题优先看：

- `apps/api/src/infrastructure/db.ts`
- 实际数据库表
- API/agent 的调用链

### 4. 模型配置是请求级快照

模型 provider、model、secret 主要来自数据库配置，由宿主在 AI 请求入队前解析为 `llmRuntime` 快照并随 IPC payload 下发。agent-runtime 子进程环境只承载身份、Redis/PostgreSQL 等运行时依赖，不应依赖进程级模型密钥。

实际注入 agent-runtime 的环境变量统一由 `apps/api/src/runtime/agent-env.ts` 生成。排查模型调用问题时优先看宿主解析出的 `llmRuntime`、数据库 provider 配置和 IPC payload。

### 5. 站内 AI Chat 是异步入队 + 流式推送

`sendOwnedChatSessionMessage()` 会先写入用户消息、抢占 `session:processing:{sessionId}` 锁、解析模型 runtime 和盘面上下文，然后 `dispatchAiChatPrompt()` 入队。HTTP 响应通常只返回 `accepted` 和 `request_id`；最终 assistant 消息由 `ipc-ai-chat-outbox-handler.ts` 落库、结算、写 conversation log，并通过 `ai-chat-stream.ts` 的 WebSocket 推送给前端。

排查“前端没显示回复”时不要只看 POST 返回值，要同时看：

- `pendingAiChatRequests`
- `ipc:{runtimeId}:inbox` / `ipc:{runtimeId}:ai-chat:outbox`
- session busy 锁
- WebSocket stream ticket 和 Redis pub/sub
- `messages.metadata.request_id`
- `conversation_logs` / `conversation_log_payloads`

### 6. 排盘和知识库不是一类东西

系统排盘由 API 侧确定性 runner 执行，目录和参数 schema 在 `paipan-registry.ts`；用户知识库是 Text Skill Bundle，正文在 `.fateclaw/text-skills` 文件系统目录。Pi Runtime 不应自行“调用排盘工具”，只读取本轮授权 Markdown Skill，并结合已写入会话的盘面 artifact 推理。

### 7. 简易模式是 `/ai-chat` 内的会话模式

简易模式现在是 `/ai-chat` 内的一种会话模式，经统一会话回合 `prepareOwnedChatSessionTurn` 入队，受同一会员门禁约束。独立的 `/api/simple-workflows/start` 路由与 `simple-workflow-service.ts` 文件均已删除，不再有单独的 preset 排盘入口。

### 8. 测试按改动范围聚焦运行

仓库保留了 Vitest 测试源文件。验证改动时优先运行对应范围的测试，再补类型检查和构建：

- `pnpm run typecheck`
- `pnpm run lint`
- 对应 workspace 的 build 命令
- 相关 `pnpm test <files...>` 焦点测试

根级 `pnpm test` 使用 Vitest；大改动不要只依赖 `--passWithNoTests` 的空覆盖结果。

### 9. 微信链路是“代码保留但整体停用，新绑定前端关闭”

`apps/api/src/app/index.ts` 当前会初始化 DB、Redis、系统排盘开关、IPC worker、retention worker 和 Fastify API，并保留为已启用且会员有效的既有微信账号启动 `startAccountPolling()` 与对应 IPC listener 的代码路径。但该循环被功能总开关 `WECHAT_CLAW_FEATURE_ENABLED=false` 与迁移 0057（账号 `enabled` 全置 false）双重短路，条件永不成立、实际零启动；`activateAccount()` 的热激活同理不会被触发，整套链路仅代码保留待恢复。

但 Web 侧 `DevicesPanel` 里 `canBindWeixin` 当前为 `false`，新扫码绑定入口仍显示暂未开放。排查主链路时仍优先按站内 AI Chat 的 `web:{userId}` runtime 理解；排查微信链路时要同时看后端轮询、会员状态、账号启用状态和前端绑定开关。

## 目录速查

- `apps/api/src/interfaces/http/`: Fastify API
- `apps/api/src/modules/skills/`: Text Skill Bundle 写入和技能 HTTP 服务
- `apps/api/src/modules/chat/paipan-registry.ts`: 系统排盘目录清单、参数 schema 和 runner 绑定
- `apps/api/src/modules/chat/paipan-runners/`: 系统排盘 TypeScript 确定性实现
- `apps/api/src/modules/chat/chat-session-service.ts`: 站内会话回合统一收口 `prepareOwnedChatSessionTurn`，简易模式也走这里（原独立 `simple-workflow-service.ts` 已删除）
- `apps/api/src/runtime/ai-chat-stream.ts`: AI Chat WebSocket stream ticket 与 Redis pub/sub
- `apps/api/src/runtime/ipc-ai-chat-outbox-handler.ts`: 站内 AI Chat 最终回复落库、结算、日志和推流
- `apps/agent-runtime/src/request-boundary.ts`: 单次请求的边界、错误映射和 trace 汇总
- `apps/agent-runtime/src/pi-runtime/`: Pi Runtime、ResourceLoader、custom tools 和 Skill 文件读取
- `apps/agent-runtime/src/text-skill-bundle.ts`: 用户 Text Skill Bundle 文件读取边界
- `apps/web/`: www 用户前端静态站点
- `apps/admin/`: admin 管理后台静态站点
- `scripts/init-pg.sql`: 数据库 schema 参考/兼容脚本；常规启动由 `initDatabase()` 自动建表和补列

## 常见误区

- 不要假设 trace 只写普通日志。当前 `conversation_logs` 保存元数据、计数和摘要，`conversation_log_payloads.trace_events` 保存 trace 正文
- 不要把 `store/` 当主存储层；那是旧版本地 SQLite 遗留路径，当前正式运行链路已不再使用
- 不要只看 `.env.example` 就断定宿主变量名，宿主实际读取逻辑在 `apps/api/src/infrastructure/config.ts` 和 `apps/api/src/runtime/agent-env.ts`
- 不要只根据 `paipan-registry.ts` 判断系统排盘是否对用户生效，还要结合 `skill_global_config` 和用户启用状态
- 不要把用户私有知识写到 `.pi/skills`、`~/.pi/agent/skills` 或任何全局扫描目录；私有知识必须是 request-scoped Text Skill Bundle
- 不要把 `dev:api-only` 和正式启动混为一谈，它明确跳过轮询、IPC worker、调度和 runtime 激活
- 不要把 AI Chat 的 HTTP `accepted` 当成最终回复；最终消息由 ai-chat outbox handler 异步写入，前端靠 WebSocket 和消息重载展示
- 不要在 agent-runtime 里找 one-shot/stdin 入口或 Dockerfile，它们已移除。当前仅保留 `daemon.ts` 入口 + Redis IPC，唯一消费宿主注入 env 的路径是 `src/context.ts`
- 系统排盘不再依赖旧版说明文件或独立脚本目录；用户知识正文在文件系统 Text Skill Bundle 中，DB 只保存 metadata 和 bundle 地址

## 模块文档

- `docs/agent-architecture.md`
- `apps/api/src/interfaces/http/AGENT.md`
- `apps/web/AGENT.md`

它们是子系统文档；这里保留仓库级理解，不重复展开细节。
