# AGENT.md

这个文件给下次进入仓库的代理或协作者使用。目标不是介绍产品，而是尽快建立“先看哪里、谁负责什么、哪些文档可能过时”的认知。

## 一句话理解

这是一个“宿主编排 + 账号级常驻 agent + Web 控台”的多账号微信私聊 AI 系统。

- 宿主在 `apps/api/src/`
- agent-runner 在 `packages/agent-runner/`
- 前端在 `apps/web/`
- Skill 仓库在 `skills/official/`

## 建议阅读顺序

第一次接手时按这个顺序读：

1. `README.md`
2. `docs/agent-architecture.md`
3. `apps/api/src/app/index.ts`
4. `apps/api/src/interfaces/http/server.ts`
5. `apps/api/src/runtime/resident-agent.ts`
6. `apps/api/src/runtime/local-runner.ts`
7. `apps/api/src/runtime/ipc-worker.ts`
8. `packages/agent-runner/src/daemon.ts`
9. `packages/agent-runner/src/engine.ts`
10. `packages/agent-runner/src/base-loop.ts`
11. `apps/api/src/infrastructure/db.ts`

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
- 通过 `apps/api/src/runtime/local-runner.ts` 以子进程方式拉起 agent-runner（`node dist/daemon.js`）
- 处理 iLink 长轮询代码路径
- 通过 Redis IPC 给账号 agent 投递请求
- 持久化消息、日志、技能配置等

优先入口：

- `apps/api/src/app/index.ts`
- `apps/api/src/app/dev-api.ts`
- `apps/api/src/modules/chat/message-handler.ts`
- `apps/api/src/runtime/poller.ts`

### Agent Runner `packages/agent-runner/`

agent-runner 负责：

- 读取宿主注入的环境变量
- 为单个账号常驻监听 inbox
- 构建 prompt
- 调用模型 provider
- 执行 tool loop
- 加载和执行 Skill
- 通过 `agent-kernel/` 做 supervisor / specialist 图式调度与能力选择
- 返回 transcript、usage、routing、trace 等结构化结果

优先入口：

- `packages/agent-runner/src/daemon.ts`
- `packages/agent-runner/src/engine.ts`
- `packages/agent-runner/src/base-loop.ts`
- `packages/agent-runner/src/agent-kernel/index.ts`
- `packages/agent-runner/src/agent-kernel/graph.ts`
- `packages/agent-runner/src/run-tool-use.ts`
- `packages/agent-runner/src/tools/registry.ts`

### Web `apps/web/`

Web 负责：

- 用户登录注册
- 账号管理和 Soul 编辑
- 聊天、日志、任务、技能、设置
- 管理后台

开发态独立运行在 `3001`，生产态是静态导出后由宿主托管。

## 关键认知

### 1. 这是按账号拆分的常驻 agent 架构

不要把它理解成“每条消息临时起一个 agent”。宿主会为运行时 ID 维持常驻 agent-runner，站内 AI Chat 使用 `web:{userId}`，微信场景使用账号 ID；`dispatchAiChatPrompt()` / `dispatchResidentPrompt()` 只是把请求投递进去。

### 2. Redis 是 IPC，不只是缓存

这里 Redis 的重要用途是宿主和 agent 之间的请求/响应/任务队列，不只是辅助缓存。

### 3. Postgres 是主要真源

排查业务问题优先看：

- `apps/api/src/infrastructure/db.ts`
- 实际数据库表
- API/agent 的调用链

### 4. 文档里可能混有旧名 `HushBay` / `NanoClaw`

仓库当前命名为 `FateClaw`，但旧日志、注释、变量和文档里仍然可能出现 `HushBay` 或 `NanoClaw`。遇到时按同一系统理解，不要误判成另一个项目。

### 5. 环境变量有“宿主名”和“agent 名”两层

- 宿主读取：`APP_OPENAI_*` / `APP_ANTHROPIC_*`
- agent-runner 使用：`OPENAI_*` / `ANTHROPIC_*`

管理后台也可以把 provider 配置写入数据库。实际注入 agent-runner 的环境变量统一由 `apps/api/src/runtime/agent-env.ts` 生成。排查模型调用问题时要同时看宿主、数据库 provider 配置和子进程视角。

### 6. 当前不保留测试源文件

仓库中的 `*.test.*` / `*.spec.*` 测试源文件已删除。验证改动时优先使用：

- `pnpm run typecheck`
- `pnpm run lint`
- 对应 workspace 的 build 命令

根级 `pnpm test` 和 API package 的 test script 仍保留 `--passWithNoTests` 兼容入口，但它们当前不代表有效测试覆盖。

### 7. 当前启动入口暂时关闭微信设备运行

`apps/api/src/app/index.ts` 当前只启动 DB、Redis、IPC worker、retention worker 和 Fastify API；微信设备 listener/poller 被显式跳过，`activateAccount()` 也不会热激活设备。排查 agent 主链路时，优先按站内 AI Chat 的 `web:{userId}` runtime 理解。

## 目录速查

- `apps/api/src/interfaces/http/`: Fastify API
- `apps/api/src/modules/skills/`: user skill 进入 prompt 前的筛选逻辑
- `packages/agent-runner/src/prompt/`: system prompt 组装
- `packages/agent-runner/src/agent-kernel/`: supervisor / specialist 调度图
- `packages/agent-runner/src/tools/skill/`: Skill 装载与执行
- `apps/web/app/admin/`: 管理后台
- `skills/official/`: 官方 Skill 元数据和说明
- `scripts/init-pg.sql`: 数据库 schema 参考/兼容脚本；常规启动由 `initDatabase()` 自动建表和补列

## 常见误区

- 不要假设 trace 只写日志。`conversation_logs.trace_events` 当前会落库
- 不要把 `store/` 当主存储层；那是旧版本地 SQLite 遗留路径，当前正式运行链路已不再使用
- 不要只看 `.env.example` 就断定宿主变量名，宿主实际读取逻辑在 `apps/api/src/infrastructure/config.ts` 和 `apps/api/src/runtime/agent-env.ts`
- 不要只根据 `skills/official/` 判断 Skill 是否生效，还要结合 `skill_global_config` 和用户订阅/启用状态
- 不要把 `dev:api-only` 和正式启动混为一谈，它明确跳过轮询、IPC worker、调度和 runtime 激活
- 不要在 agent-runner 里找 one-shot/stdin 入口或 Dockerfile，它们已在 2026-04-21 移除。当前仅保留 `daemon.ts` 入口 + Redis IPC，唯一消费宿主注入 env 的路径是 `src/context.ts`
- skill 元数据只读 `skill.json`，旧的 `metadata.json` 回退分支已移除

## 模块文档

- `docs/agent-architecture.md`
- `apps/api/src/interfaces/http/AGENT.md`
- `apps/web/AGENT.md`

它们是子系统文档；这里保留仓库级理解，不重复展开细节。
