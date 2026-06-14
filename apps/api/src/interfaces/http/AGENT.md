# API 模块

这里是宿主进程上的 Fastify API，不是独立服务。它和账号运行时、数据库、日志系统共处于同一 Node 进程里。

## 从哪里看起

优先阅读：

1. `apps/api/src/interfaces/http/server.ts`
2. `apps/api/src/interfaces/http/auth-routes.ts`
3. `apps/api/src/interfaces/http/account-routes.ts`
4. `apps/api/src/interfaces/http/messages-routes.ts`
5. `apps/api/src/interfaces/http/skills-routes.ts`
6. `apps/api/src/infrastructure/db.ts`

## 结构

```text
apps/api/src/interfaces/http/
├── server.ts       # Fastify 服务创建、插件注册、全局钩子、错误处理、静态站点托管
├── captcha.ts      # 验证码能力
├── rate-limit.ts   # 限流辅助
├── account-routes.ts
├── admin-routes.ts
├── auth-routes.ts
├── billing-routes.ts
├── chat-sessions-routes.ts
├── model-settings-routes.ts
├── messages-routes.ts
├── paipan-routes.ts
├── public-routes.ts
└── skills-routes.ts
```

配套业务模块：

- `apps/api/src/modules/user/auth-service.ts`：注册、登录、用户安全 DTO
- `apps/api/src/modules/account/account-http-service.ts`：账号绑定、运行时停启、Soul 读写
- `apps/api/src/modules/chat/web-chat-service.ts`：网页聊天消息收发
- `apps/api/src/modules/chat/chat-session-service.ts`：AI 对话会话与查询过程
- `apps/api/src/modules/chat/paipan-service.ts`：直排盘预览与提交到 AI Chat
- `apps/api/src/modules/billing/billing-service.ts`：计费快照与用户重置
- `apps/api/src/modules/skills/skills-service.ts`：技能域门面
- `apps/api/src/modules/admin/admin-service.ts`：管理后台聚合逻辑
- `apps/api/src/infrastructure/db.ts`：底层数据访问层

## 当前路由装配

`apps/api/src/interfaces/http/server.ts` 当前注册的前缀：

- `/api/admin`
- `/api/auth`
- `/api/account`
- `/api/chat-sessions`
- `/api/messages`
- `/api/model-settings`
- `/api/paipan`
- `/api/public`
- `/api/referrals`
- `/api/skills`
- `/api/simple-workflows`
- `/api/billing`
- `/api/health`
- `/api/ready`

加路由时，优先沿用现有 prefix 分组，不要新建风格不一致的前缀。

## 关键行为

### 鉴权

- 使用 `@fastify/jwt`
- `request.requireAuth()` 在 `onRequest` hook 里注入
- 大部分登录态接口由路由内部主动调用 `request.requireAuth()`
- 管理后台通常走 `MANAGER_KEY` 体系，和普通用户 JWT 不是一套认证入口

### 错误处理

- `server.ts` 统一设置 `setErrorHandler`
- 4xx 走 warn，5xx 走 error
- API 错误返回 JSON，不返回 HTML

### 静态前端托管

- 如果 `apps/web/out/` 存在，Fastify 会直接托管静态导出结果
- 404 时对 `/api/*` 返回 JSON 404
- 非 API 页面请求优先尝试 `{path}/index.html`、`{path}.html`
- App Router 客户端跳转触发的 `{path}.txt` 会补映射到真实的 `route/index.txt`
- 真实缺失的静态资源返回 404，不再错误兜底到首页

这意味着 API 层同时承担了前端生产站点托管职责。

### AI Chat 异步链路

站内 AI Chat 的发送接口不是同步拿最终回复：

- `POST /api/chat-sessions/s/:sessionId/messages` 由 `chat-session-service.ts` 写入用户消息、抢占会话锁、解析 `llmRuntime` 后入队。
- 正常响应通常是 `accepted: true` 和 `request_id`，最终 assistant 消息由 `runtime/ipc-ai-chat-outbox-handler.ts` 从 `ipc:{runtimeId}:ai-chat:outbox` 异步落库。
- 前端实时展示走 `runtime/ai-chat-stream.ts`：先 `POST /api/chat-sessions/s/:sessionId/stream-ticket`，再连 `/api/chat-sessions/s/:sessionId/stream` WebSocket。
- 取消接口会释放 pending、会话锁、全局并发槽和本地 agent 租约，并向 `ipc:{runtimeId}:cancel` 写入取消请求。

### 排盘与简易模式

- `/api/paipan/*` 是 API 内部 TypeScript runner 的确定性排盘，不需要模型 runtime。
- `/api/simple-workflows/start` 先按后台 preset 直接排盘创建会话和盘面消息，再异步启动首轮 AI Chat；preset 可以限制模型策略和本轮授权 Skill。

### 健康探针

- `/api/health` 只返回进程存活状态
- `/api/ready` 会检查 PostgreSQL 与 Redis，可用于部署就绪探针

## 和数据库的关系

路由层应尽量保持薄，业务流程优先下沉到 `apps/api/src/modules/*` service。理解接口行为时，不要只读 route handler，至少还要同步看：

- 对应模块 service 的编排逻辑
- 数据表结构创建/迁移
- 查询字段
- 所有权校验
- 开关与状态字段

## 改动约定

- 新接口优先复用现有 prefix
- 返回结构尽量延续当前中文错误消息风格
- 权限校验要和资源所有权绑定，不要只校验 JWT
- 如果改了 API 路由或参数，同步检查 `apps/web/features/*/api.ts`、`apps/web/lib/admin-api.ts` 和 `docs/api-reference.md`
- 仓库保留了 API Vitest 测试源文件；API 改动后优先跑相关 `*.test.ts`，再跑 `pnpm --filter @fateclaw/api typecheck` 和 `pnpm --filter @fateclaw/api lint`
