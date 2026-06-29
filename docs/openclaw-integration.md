# 微信 OpenClaw/iLink 对接说明

FateClaw 保留了微信 OpenClaw/iLink Bot 的对接代码路径。后端正式启动入口仍保留为已启用且会员有效的既有账号启动 iLink 长轮询和 IPC listener 的相关代码，但因 `WECHAT_CLAW_FEATURE_ENABLED=false` 与迁移 0057（`accounts.enabled=false`）双重短路，启动时实际启动 0 个账号；Web 侧新扫码绑定入口同样暂未开放。本文档用于说明现状和完整恢复这条链路时需要检查的边界。

## 当前状态

- 站内 AI Chat 是当前稳定主链路。
- `apps/api/src/app/index.ts` 初始化 DB、系统排盘开关、Redis、IPC worker、retention worker 和 Fastify API。
- 正式启动会读取 `getEnabledAccounts()`，仅为有 `owner_id` 且会员状态有效的账号启动 `startAccountPolling()`，并把这些账号注册到 `startIpcWorker(memberAccounts)`。
- `activateAccount()` 会调用 `addAccountListener(account.id)` 并启动该账号轮询，用于绑定后的热激活。
- `pnpm run dev:api-only` 轻量入口只启动 DB、Redis 和 API Server，会跳过 iLink 轮询、IPC worker 和 runtime 激活。
- Web 侧设备绑定入口暂未开放：前端用 `WECHAT_DEVICE_BINDING_DISABLED_MESSAGE` 常量（`account-service.ts`）提示暂未开放，后端 `checkAccountBindingLimit`（`account-http-service.ts`）拦截新绑定请求。

这意味着：后端已有微信运行链路，但产品层面没有重新开放新绑定；完整恢复微信入口时不能只看后端轮询，还要同步前端开关、会员/账号策略和外部平台协议。

## 相关模块

- `apps/api/src/infrastructure/ilink.ts`：OpenClaw/iLink 请求、扫码登录、长轮询、消息发送和消息转换。
- `apps/api/src/modules/account/`：账号绑定、账号 HTTP 服务和账号管理逻辑。
- `apps/api/src/modules/chat/message-handler.ts`：微信消息进入 Agent 前的处理链路。
- `apps/api/src/runtime/poller.ts`：轮询入口。
- `apps/api/src/runtime/resident-agent.ts`：向账号级 agent-runtime 分发请求。
- `apps/api/src/runtime/ipc-outbox-handler.ts`：处理 agent-runtime 返回并发送微信消息。
- `apps/web/components/workspace/`：设备和绑定相关 UI。

## 恢复接入前的检查清单

1. 确认 OpenClaw/iLink Bot API 的 Base URL、token、扫码登录和消息发送接口仍与 `ilink.ts` 中的协议一致。
2. 明确账号和用户的绑定关系，避免一个微信账号被错误绑定到多个用户。
3. 恢复新绑定入口时，确认 `DevicesPanel` 的前端开关、扫码绑定 API、`startIpcWorker()`、账号 listener/poller、agent-runtime 生命周期和优雅退出顺序。
4. 确认 `dispatchResidentPrompt()` 的 `autoDeliver` 行为和 outbox 处理仍符合微信自动发送要求。
5. 增加速率限制、错误重试和幂等处理，避免重复发送或失控刷屏。
6. 检查日志脱敏，避免记录 bot token、用户微信 ID、私聊内容和模型密钥。
7. 更新 README、API 文档和 Web 设备页文案，明确微信链路的可用范围：既有账号轮询、新绑定、自动发送和故障降级是否全部开放。

## 环境变量和凭据

OpenClaw/iLink 凭据主要随账号配置保存，不应写入仓库。任何 bot token、扫码登录结果、账号导出和消息样本都必须脱敏后再用于 Issue 或 PR。

## 运行边界

微信对接属于外部平台集成，可能受到第三方服务可用性、接口变化、账号风控和消息频控影响。生产部署时建议把微信链路和站内 AI Chat 的监控指标分开看，避免把外部平台异常误判为 Agent 核心能力异常。
