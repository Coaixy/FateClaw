# AI Chat「发送后卡在正在回复、无内容」修复方案

日期：2026-07-01
状态：待执行（明天开始）

## 事故与根因回顾

现象：部分账号发送 AI Chat 消息后，界面立刻显示"AI 正在回复"，但从头到尾没有任何内容流出，一直卡住。

排查确认：Web Chat 的 `POST /api/chat-sessions/s/:id/messages` 走 `waitForResponse:false`
（`apps/api/src/modules/chat/chat-session-service.ts:947` `enqueuePreparedOwnedChatSessionTurn`），
只要进入 `acquireGlobalAgentSlot` 就会在 `onQueued` 回调里立刻 resolve 一个"已受理"响应
（`apps/api/src/runtime/ipc-worker.ts:1250-1256`）——所以"AI 正在回复"出现得很快，跟真正开始生成
没有关系。真正处理请求靠账号级本地 agent-runtime 子进程消费 Redis inbox 队列
（`ipc:{accountId}:inbox` / `:inbox:member`）。

根因链路：

1. `ensureLocalAgentRunning` / `doSpawnLocalAgent`（`apps/api/src/runtime/local-runner.ts:305-332,378-519`）
   只负责 `spawn()`，不确认子进程真正连上 Redis 并开始消费——没有 ready 握手、没有超时。
2. 唯一的兜底——30 分钟请求超时（`apps/api/src/runtime/ipc-worker.ts:1073` `AI_CHAT_REQUEST_TIMEOUT`）
   是纯内存态的 `pendingAiChatRequests` + `setTimeout`，只活在发起请求那个 API 进程实例里。
   API 进程一重启，这个状态和定时器全部消失，但消息已经躺进 Redis inbox 队列，从此没人再管。
3. 全程没有队列深度/消息年龄的监控告警。

实测证据：3 个 web 账号的 `ipc:web:<id>:inbox:member` 队列堆积 3/16/15 条消息，最老一条堆积
约 8 小时；同时 `agent:concurrency:active` 和 `wait:*` 队列是干净的，说明不是全局并发耗尽，
而是这几个账号的消费者（本地 agent-runtime 子进程）掉线了。

**待确认**：这几个账号的子进程当时具体为什么停止消费（崩溃退出 / 启动失败 / 卡死不退出），
需要查服务器日志（搜 `启动本地 agent 进程`＝已尝试拉起、`本地 agent 进程已就绪`＝已连上
Redis 可消费、`本地 agent 进程已退出` / `本地 agent 进程出错`）确认后看要不要额外补一个针对性
修复。就绪握手落地后，有「启动本地 agent 进程」却无「本地 agent 进程已就绪」即卡在就绪阶段
（连 Redis 失败或就绪超时被杀）。

## 修复项（按优先级）

### P0：队列消费停滞监控告警

**问题**：系统没有任何信号能说明"某个账号的消息堆积了"，这次问题存在 8 小时才被用户投诉发现。

**方案**：新增一个定时巡检（API 进程内的 interval，或独立 cron 脚本），扫描所有
`ipc:*:inbox*` 队列：
- `LLEN` 拿队列长度；
- `LRANGE queue -1 -1` 取队尾（最老）一条，解析 payload 的 `timestamp` 字段算年龄；
- 年龄超过阈值（建议 3-5 分钟，参考正常处理时长）就告警（日志 error 级别 + 接入现有告警渠道）。

**验收标准**：人为让某账号的本地 agent 子进程不消费（或直接停掉），巡检应在下一个周期内告警。

### P0/P1：自愈——基于 Redis 而非内存状态清理超龄请求

**问题**：现有的 30 分钟超时兜底是内存态的，扛不住 API 进程重启。

**方案**：在上面的巡检里，发现某账号队列消息年龄超过阈值时，直接复用
`failInFlightAiChatRequestsForAccount`（`apps/api/src/runtime/ipc-worker.ts:928`）同样的清理套路：
释放 `session:processing:{sessionId}` 锁、给用户推一条"处理超时，请重新发送"的错误消息、
从 inbox 队列移除这条陈旧消息。这个判断只依赖 Redis 里的数据，天然扛得住 API 进程重启。

**验收标准**：模拟 API 进程重启后遗留的陈旧 inbox 消息，巡检应能独立发现并清理，不依赖内存状态。

### P1：本地 agent 子进程加"就绪确认"

**问题**：`ensureLocalAgentRunning` 现在只要 `spawn()` 没抛错就认为成功，不确认子进程是否真的
连上 Redis、开始消费队列。

**方案**：agent-runtime 的 `daemon.ts` 在 `connectRedis()` 成功后，通过 `process.send`
（Node 子进程 IPC）通知父进程"已就绪"；`local-runner.ts` 的 `ensureLocalAgentRunning` 等待这个
信号，加超时（建议 15-30 秒），超时就当启动失败处理并抛错，而不是盲目信任 `spawn()` 已成功。

**验收标准**：人为让子进程在 `connectRedis()` 之前抛异常/挂起，`ensureLocalAgentRunning` 应在
超时后明确失败，而不是让调用方以为"已经在运行"。

### P2：前端 WS 静默超时提示 + 重发入口

**问题**：前端不区分"正在流式生成"和"发出去之后再没收到任何事件"，用户只能死等。

**方案**：WS 静默超过一定时间（建议 60-90 秒无任何事件）后，把"AI 正在回复"文案换成
"响应时间较长，可能遇到问题"之类提示，并提供"重新发送"按钮。涉及
`apps/web/features/chat/hooks/use-chat-messages.ts` 和 `ai-chat-message-list.tsx` 的
`StreamingTrajectory` 展示逻辑。

### P2：前端请求补一个兜底超时

**问题**：`requestJson`（`apps/web/lib/http/client.ts:84`）的 fetch 完全没有超时。这次不是主因
（web chat 走的是快速 resolve），但作为纵深防御值得补上。

**方案**：给 `chatSessionsApi.send` 等长耗时请求加合理上限（建议 60-90 秒，用
`AbortSignal.timeout` 与调用方已有的 `AbortController` 组合）。

## 建议实施顺序

1. P0 队列监控告警 + P0/P1 自愈清理（同一个巡检逻辑的自然延伸，建议一起做，性价比最高）
2. P1 本地 agent 就绪确认
3. P2 两项前端兜底

## 后续

修完并验证后，把这次事故的根因和修复结果补充到本文件顶部或
[agent-architecture.md](../agent-architecture.md)，避免以后重复排查同样的问题。
