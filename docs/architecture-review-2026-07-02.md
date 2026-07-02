# apps/api 与 apps/agent-runtime 架构审查清单（2026-07-02）

> 审查方法：四路并行审查（进程/IPC 生命周期、修复类提交考古、错误处理与数据流、测试与部署运维），
> 全部发现经人工交叉验证代码证据后收录。本文档同时记录「审查到但决定不改」的项目及理由。

## 背景：修复历史揭示的病根

对 `apps/api/src/runtime`、`apps/agent-runtime/src` 的 git 考古显示，2026-06 至 07 的密集修复
（b524e6b9 → af3e693a → 7ec59ea6 → b6779ead → b1c0ab8d → bd7c64a1 → d716fa83 → e6109f00）
聚类为四个反复发作的架构级病根：

- **病根 A**：`b524e6b9` 为提速把「HTTP 受理」与「请求真正被处理」解耦，但没有同步引入跨进程、
  扛重启的完成/失败状态机。此后所有兜底（内存 `pendingAiChatRequests` + `setTimeout`）都活在
  单个 API 进程内存里，直接催生了后续 5 个连续卡死修复。
- **病根 B**：「进程/连接活着 = 可用」的乐观假设贯穿子进程生命周期管理（就绪握手、请求级超时、
  崩溃兜底都是事后逐个补的）。
- **病根 C**：账务采用「无冻结 + 事后收尾结算」，与「token 已消耗」存在系统性时间差
  （两次修复提交均明确声明不复活冻结机制——业主决策，本轮不翻案）。
- **病根 D**：跨进程错误响应缺乏单一构造出口（已在 e6109f00 收敛出 `buildAiChatErrorResponsePayload`），
  但 reasonCode 仍是裸字符串、两套错误映射器仍在发散。

修复热点文件：`ipc-worker.ts`（33 次）、`ipc-payloads.ts`（21 次）、`ipc-ai-chat-outbox-handler.ts`（20 次）、
`daemon.ts`（11 次）、`local-runner.ts`（9 次）——前四者均为同一病根反复发作。

---

## P0 — 正确性缺陷（可造成用户可见卡死或资源无界泄漏）

### P0-1 全局并发等待队列可被崩溃进程永久毒化（活性死锁）

- **证据**：`apps/api/src/runtime/ipc-worker.ts:173-222`（Lua 只对 active ZSET 做
  `ZREMRANGEBYSCORE`，等待 LIST 无任何老化清理）；`:287-315`（把 requestId 移出等待
  LIST 的唯一路径是等待者自己 catch 里的 `lrem`）。
- **触发**：API 进程在请求排队期间崩溃/重启 → 孤儿 requestId 永卡队尾 → FIFO 判定
  `LINDEX 队尾 == 自己` 使同优先级所有后继请求永远得到 `not_turn`，除非人工清 Redis。
- **为什么是架构问题**：并发闸门的正确性依赖「每个入队者最终一定亲自出队」这一在崩溃下
  不成立的假设，没有旁路清扫者。
- **改法**：等待队列 LIST → ZSET（score=入队时间）+ 心跳哈希（等待者每次轮询报活），
  Lua 原子驱逐心跳超时的死亡队头；等待者发现自己被误逐（`missing`）时自动重新入队。

### P0-2 API 重启后 ai-chat outbox 无消费者，已完成的回复永久滞留

- **证据**：`apps/api/src/app/index.ts:78-89`（启动只重建微信账号监听，`web:{userId}`
  监听只在用户发新消息时懒创建）；`ipc-worker.ts:110-112`（pending 纯内存）；
  `inbox-stall-sweeper.ts:37`（巡检 MATCH `ipc:*:inbox*`，无 outbox 巡检）。
- **触发**：API 非优雅退出时，孤儿 agent 子进程仍可能把 response LPUSH 到
  `ipc:web:{userId}:ai-chat:outbox`；新 API 进程没有该账号的监听器，响应永久堆积，
  用户侧表现为「回复永远不出现」。这是病根 A 的直接残留。
- **关键事实**（决定改法可行）：`ipc-ai-chat-outbox-handler.ts:394-398` 最终响应落库有
  `payload.sessionId` 兜底，**不依赖本机 pending**——只要有人消费，消息就能落库+推流。
- **改法**：扩展 stall-sweeper 巡检 `ipc:*:ai-chat:outbox`，堆积超阈值的消息直接经
  `processAiChatOutboxPayload` 消费（空 pending map）；计费由 billing-sweeper 按
  conversation_logs 补结算（机制已存在）。微信 `ipc:*:outbox` 只告警不代消费（有发信副作用）。

### P0-3 web 账号 outbox 监听器只增不删，Redis 连接数无界增长

- **证据**：`ipc-worker.ts:1226`（每次 AI Chat 提交都 `addAccountListener`）；`:549`
  （每个监听器 `getRedis().duplicate()` 独占一条连接 + 常驻 1s BRPOP 循环）；
  `removeAccountListener` 仅在微信账号删除/禁用时被调用（站内用户永不触发）。
- **后果**：进程存活期内每个历史活跃用户各留一条常驻 Redis 连接 + 一个 supervisor 协程，
  随用户数线性增长且不可回收。
- **改法**：非固定（pinned）监听器空闲自动回收——该账号无 pending 请求且空闲超过 TTL
  时监听协程自行退出；回收后迟到的消息由 P0-2 的 outbox 巡检兜底，不会丢。
  微信账号监听保持常驻（pinned）。

## P1 — 停机与超时时序一致性

### P1-1 停机链三层时序错位，优雅退出被逐层截断

- **证据**：
  - PM2 无 `kill_timeout`（`ecosystem.config.cjs`），默认 1.6s 后 SIGKILL 主进程；
  - `app/index.ts:114` `stopAllLocalAgents()` 不等待子进程退出即继续断开 Redis/DB 并 `process.exit(0)`；
  - 宿主强杀延迟 10s（`local-runner.ts:23`）< daemon 优雅 drain 30s（`daemon.ts:440`）；
  - `ecosystem.config.cjs:7` `env_file: '.env.production'`，但打包与文档链路只有 `.env`
    （`scripts/pack.sh:201-205`、`docs/deployment-split.md`）。
- **后果**：经 PM2 重启时在途对话几乎必然被强杀；daemon 的 30s drain 窗口永远用不满；
  响应丢失后再依赖 sweeper 层层兜底。
- **改法**：shutdown 场景强杀延迟放宽到 drain+5s；`stopAllLocalAgents` 返回可 await 的
  「全部退出或超时」Promise，`app/index.ts` 等它完成后再关 Redis/DB；PM2 加
  `kill_timeout`（覆盖整条内部停机链）；`env_file` 改 `.env`。

### P1-2 同一请求链路三个超时变量名、默认值矛盾、跨进程人肉对齐

- **证据**：api 侧 `AGENT_REQUEST_TIMEOUT`/`AI_CHAT_REQUEST_TIMEOUT` 默认 30min
  （`ipc-worker.ts:18,1072`）；daemon 侧读第三个变量名 `AGENT_RUNTIME_REQUEST_TIMEOUT_MS`
  默认 8min（`daemon.ts:33`）；stall-sweeper 清理阈值 10min 硬编码且注释里人肉标注
  「比 daemon 8 分钟更长」（`inbox-stall-sweeper.ts:29-33`）；会话锁 TTL 35min 同样
  硬编码注释对齐（`ipc-worker.ts:1299`）。
- **后果**：任何一处被运维改动（如把 daemon 超时调到 15min）都会静默破坏
  「daemon 超时 < sweeper 清理阈值 < api 超时 < 会话锁 TTL」不变式，重新引入误杀/双写。
- **改法**：api 侧新增超时链单一事实源模块，全部派生值（sweeper 阈值、锁 TTL）从中导出；
  spawn 子进程时把 daemon 超时经 env 注入（`agent-env.ts`），保证跨进程一致；
  不变式用启动断言 + 单测锁定。

## P2 — 跨进程错误契约

### P2-1 reasonCode 裸字符串（全仓 13 种散落）+ 两套错误映射规则发散

- **证据**：`ipc-payloads.ts:21` `publicReasonCode?: string` 无类型约束；
  `packages/contracts` 无任何 ReasonCode 定义；`apps/api/src/shared/public-error.ts:21`
  与 `apps/agent-runtime/src/public-error.ts:115` 各自维护几乎相同的正则表
  （api 版多 `router_error`，agent 版多 `custom_model_error` + BYOK 脱敏），改一处极易漏另一处
  ——这正是病根 D 的残留形态。
- **改法**：`packages/contracts` 定义 `PublicReasonCode` 联合类型（api/web/admin 共享）；
  共享的「错误特征 → reasonCode + 用户文案」规则表下沉到 `packages/backend-shared/assets`
  （沿用 model-context-windows.json 的既有共享模式，agent-runtime 无需新增包依赖），
  两侧映射器改为「共享规则表 + 各自扩展」。

### P2-2 IPC payload 跨进程零结构校验（记录，本轮最小化处理）

- **证据**：`daemon.ts:96,112,407` 裸 `JSON.parse as Partial<...>`；
  `ipc-payloads.ts:275-311` 只校验顶层 3-4 个字段，`metadata/usage/transcript` 等均为
  `unknown` 直落库。
- **处理**：本轮仅做「无效 payload 不静默」——API 消费侧对校验失败的消息记录死信日志
  （保留原文），不再直接抛错吞掉。全量 zod 化改动面大、收益递减，列入后续项。

## P3 — 计费一致性

### P3-1 扣费先于消息落库，交付失败不退款

- **证据**：`ipc-ai-chat-outbox-handler.ts:614`（`settleAiChatBilling` 实扣）先于
  `:625`（`storeAiChatFinalResponseMessages` 落库）；catch（`:658-701`）只释放锁并
  resolve error，无退款补偿；billing-sweeper 只回收 `charge_state='pending'` 的预留
  （`billing-repository.ts` `WHERE charge_state='pending'`），已 charged 的不会被扫到。
- **后果**：落库失败时用户被扣费但收不到消息。
- **改法**：顺序调换为「先落库、再结算」。安全性依据：落库失败时预留保持 pending，
  billing-sweeper 按 conversation_logs 真实 usage 补收（`billing-sweeper.ts:93-115`，
  日志在结算前已异步落库），漏收敞口不变，「扣了钱没交付」的敞口归零。
  消息 metadata 中的扣费金额字段随之只进入流事件与 resolve 结果（详见实施记录）。

## P4 — 可观测性

### P4-1 异常检测只落日志，无告警投递

- **证据**：inbox 堆积告警/清理只 `logger.warn/error`（`inbox-stall-sweeper.ts:151,196,202`）；
  子进程异常退出只 `logger.warn`（`local-runner.ts:540`）；`conversation-log-metrics.ts:28`
  注释写「触发告警」实际仅落日志。事故复盘（`docs/archive/ai-chat-agent-runtime-stall-fix-plan-2026-07-01.md`）
  实测堆积近 8 小时才被用户投诉发现。
- **改法**：新增轻量运维告警模块（`ALERT_WEBHOOK_URL` 可选配置，POST JSON，按事件类型
  节流防风暴，未配置时降级为日志）。接入点：inbox/outbox 堆积清理、子进程异常退出、
  billing sweeper 按 0 关账。不引入外部监控中间件，符合部署形态约束。

### P4-2 agent-runtime 无心跳，掉线最快也要 10 分钟才能从 inbox 堆积间接发现

- **证据**：daemon 就绪信号只在启动时打一次（`daemon.ts:430`）；此后唯一的存活探测是
  inbox 堆积巡检（触发下限 10min）。
- **改法**：daemon 周期性写 `agent:heartbeat:{accountId}`（带 TTL）；stall-sweeper 对
  「队列非空但心跳缺失」的账号提前升级告警；新增 admin 运行时状态接口 + 页面
  （活跃子进程、监听器、pending 数、队列深度、心跳），让掉线可以被主动看见。

## P5 — 伴随项

- 上述每项改动补齐单元测试（`apps/api/tests/runtime/` 已有基础设施）。
- `docs/deployment-split.md` 与 `ecosystem.config.cjs` 对齐（PM2 路径、健康检查接入）。

---

## 实施记录（2026-07-02，与本清单同轮完成）

| 项 | 实施方式 | 主要改动 |
| --- | --- | --- |
| P0-1 | 等待队列 LIST → ZSET + 心跳哈希，Lua 原子驱逐死亡队头（15s 心跳超时）；`missing` 时自动重新入队；启动时一次性清理旧 LIST key | `ipc-worker.ts`（`waitq:*` 新 key、`enqueueGlobalAgentWaiter`/`removeGlobalAgentWaiter`） |
| P0-2 | stall-sweeper 扩展 `ipc:*:ai-chat:outbox` 巡检：无主阈值 3 分钟，代消费落库+推流+释放并发槽，脏数据死信弹出 | `inbox-stall-sweeper.ts`（`sweepAiChatOutboxQueue`）、`timeout-chain.ts`（`AI_CHAT_OUTBOX_ORPHAN_MS`） |
| P0-3 | 非 pinned 监听器空闲 10 分钟且无在途请求时自动退出；微信监听 pinned 常驻 | `ipc-worker.ts`（`pinnedAccountListeners`、`listenForAccount` 空闲回收） |
| P1-1 | `stopAllLocalAgents` 改为可 await（等全部退出或 36s 上限）；shutdown 场景强杀延迟 35s（> daemon drain 30s）；PM2 加 `kill_timeout: 45000`、`env_file` 修正为 `.env` | `local-runner.ts`、`app/index.ts`、`ecosystem.config.cjs` |
| P1-2 | 新建超时链单一事实源，派生 inbox 清理阈值与会话锁 TTL，违例启动即抛错；daemon 超时经 `agent-env.ts` 注入子进程（修复了该 env 旋钮从未透传生效的隐藏问题） | `shared/timeout-chain.ts`、`agent-env.ts`、`ipc-worker.ts`、`inbox-stall-sweeper.ts` |
| P2-1 | contracts 新增 `PUBLIC_REASON_CODES`/`PublicReasonCode`；agent-runtime 维护镜像类型（其构建刻意不依赖 contracts），一致性由跨包契约测试锁定；两侧映射器与 `buildAiChatErrorResponsePayload` 返回/入参类型收紧 | `packages/contracts/src/common/reason-codes.ts`、`agent-runtime/src/types.ts`、`tests/shared/reason-codes-contract.test.ts` |
| P2-2（最小版） | IPC 消费失败与 outbox 死信均记录 `rawPreview`（保留原文前缀），不再静默消失 | `ipc-worker.ts`、`inbox-stall-sweeper.ts` |
| P3-1 | 最终响应改为「先落库交付、再结算扣费」；结算失败只记日志交 sweeper 补收；扣费金额结算后回填最终消息 metadata（保住 web 端历史展示） | `ipc-ai-chat-outbox-handler.ts`、`chat-repository.ts`（`mergeMessageMetadata`） |
| P4-1 | 新增 `ALERT_WEBHOOK_URL` 可选告警通道（按 kind 5 分钟节流，失败静默降级）；接入 inbox/outbox 堆积清理、不可恢复堆积、子进程异常退出、计费按 0 关账 | `infrastructure/alerts.ts`、`config.ts`、各接入点 |
| P4-2 | daemon 每 10s 写 `agent:heartbeat:{accountId}`（TTL 30s，优雅退出主动删）；巡检对「有堆积但心跳缺失」立即告警；admin「运行状态」页新增运行时基础设施面板（子进程/监听器/队列深度/心跳/并发闸门），接口 `GET /api/admin/runtime-status` | `daemon.ts`、`runtime-status.ts`、`admin-routes.ts`、`apps/admin` status 页 |
| P5 | 新增/更新测试：等待队列 ZSET、outbox 代消费、心跳升级、停机等待、超时链不变式、reasonCode 跨包契约；顺手修复 3 个存量红测试的 mock 缺失；文档同步 `deployment-split.md` 与 `agent-architecture.md` | `apps/api/tests/**` |

未尽事项：`.env.example` 因权限限制未能补充 `ALERT_WEBHOOK_URL` 说明（需手动添加）；`apps/web/tests/features/chat/api.test.ts`（5 例）与 `chat-session-service.test.ts`（1 例）为存量失败（2026-06-29 非会员放开决策后测试未同步），不属本轮范围。

## 审查到但本轮不改（含理由）

| 发现 | 理由 |
| --- | --- |
| 无冻结账务结构（病根 C 本体） | af3e693a/7ec59ea6 两次提交均明确声明「不复活冻结机制」，属业主决策；现有 per-user 并发门 + billing-sweeper 已围住敞口。 |
| 水平扩容下多实例竞争同一 inbox/outbox（pending 错配） | 当前部署形态为单实例 PM2；改多实例路由属大改，超出「部署形态不变」约束。记录在案。 |
| `billing-repository.ts`（2392 行）等 god file 拆分 | 纯重构，与本轮正确性主题偏离，风险收益比不佳。 |
| IPC 全量 zod 化 | 见 P2-2，本轮只做死信日志。 |
| 集成测试基础设施（真实 PG/Redis） | 工程量大，独立立项更合适；本轮以单测锁定新逻辑。 |
| `resident-agent.ts`/`retention.ts` 零测试 | 随本轮触碰到的部分补测，不单独立项。 |
