# code-review-2026-06-16 修复方案

> 日期：2026-06-16  
> 对象：`docs/code-review-2026-06-16.md` 中列出的 `apps/api` 与 `apps/agent-runtime` 问题  
> 说明：本文按模块归类，不表达修复优先级。每项包含正确性判断、代码改动方案和验证要求。

## 总体结论

review 中多数问题能在当前源码中找到对应风险，但部分问题的影响描述过重，或没有完整追踪实际调用路径。

成立或基本成立的问题：

- #2 并发槽位 ID 时序窗口
- #3 WebSocket frameBuffer 无界增长
- #4 Admin 用户列表全量加载与 N+1 查询
- #5 Redis IPC listener 异常退出不重启
- #6 iLink 轮询消息处理无并发控制
- #7 WebSocket 无心跳与空闲超时
- #9 结算记录缺失时静默 0 扣费
- #11 月用量查询使用 `LIKE`
- #12 agent-runtime 单账号串行处理
- #13 `pendingCancelRequests` 无 TTL
- #16 retention timer 未 `unref`

部分成立或需要修正表述的问题：

- #1 全局并发等待队列确实存在非原子检查与弹出风险，但 review 中“另一个不同 requestId 的实例也会弹出”的推演不严谨，因为当前代码会用 `nextRequestId !== input.requestId` 拦截。真实风险来自队列尾部在检查与弹出之间被 timeout/cancel 清理、以及新请求绕过已有等待队列的公平性问题。
- #8 计费预留金额为 0 与当前代码注释和单测一致，属于后付费/可欠费设计；如果产品目标是预付费硬门禁，它才是逻辑缺陷。
- #10 `resolveAccountId` 的全表扫描是坏兜底，但正常 IPC 处理路径会传入 `fallbackAccountId`，不是每条 IPC 消息都会触发。
- #14 字符串截断算法可能在混合多字节字符串中超限，但纯中文场景不一定会达到 review 说的 2-3 倍。
- #15 主路径不成立。API 侧已经计算 `maxOutputTokens` 并放入 `llmRuntime` payload，agent-runtime 实际注册 provider 时优先使用 payload 中的 `maxOutputTokens`。

## 全局 agent 并发门禁

涉及文件：

- `apps/api/src/runtime/ipc-worker.ts`
- `apps/api/tests/runtime/ipc-worker.test.ts`

覆盖 review 项：

- #1 全局并发槽位等待队列竞态条件
- #2 并发槽位 ID 赋值时序窗口

### 当前问题

`acquireGlobalAgentSlot` 当前使用多个 Redis 命令组合完成排队和抢占：

- `lpush` 写等待队列。
- `lindex(..., -1)` 查看队尾。
- `tryAcquireGlobalAgentSlot` 通过 Lua 写 active zset。
- `rpop` 从等待队列弹出队尾。

这组操作之间不是一个原子单元。虽然不同 requestId 不会因为单纯看到同一个队尾而同时通过 `nextRequestId !== input.requestId`，但仍存在以下风险：

- 请求在检查队尾后被 timeout/cancel 通过 `lrem` 移除，原请求继续执行时可能 `rpop` 掉别人的队列项。
- 新请求在等待队列已有请求时仍可能通过 fast-path 直接抢占槽位，破坏队列公平性。
- 槽位已经写入 active zset，但 pending 尚未记录 `concurrencySlotId` 时，timeout handler 只能释放 `undefined`。
- timeout 删除 pending 后，提交协程仍可能从 `acquireGlobalAgentSlot` 返回并继续 enqueue payload。

### 修复设计

把“选择下一位等待者、检查 active 数量、弹出等待队列、写 active zset”合并为一个 Redis Lua 脚本。脚本输入：

- `KEYS[1]`: active zset key
- `KEYS[2]`: member wait queue key
- `KEYS[3]`: normal wait queue key
- `ARGV[1]`: concurrency limit
- `ARGV[2]`: now timestamp
- `ARGV[3]`: expired-before timestamp
- `ARGV[4]`: current requestId

脚本行为：

```lua
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3])

if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  return {0, 'busy'}
end

local memberTail = redis.call('LINDEX', KEYS[2], -1)
if memberTail then
  if memberTail ~= ARGV[4] then
    return {0, 'not_turn'}
  end
  redis.call('RPOP', KEYS[2])
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  return {1, 'member'}
end

local normalTail = redis.call('LINDEX', KEYS[3], -1)
if normalTail then
  if normalTail ~= ARGV[4] then
    return {0, 'not_turn'}
  end
  redis.call('RPOP', KEYS[3])
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  return {1, 'normal'}
end

return {0, 'missing'}
```

实现约束：

- 请求统一进入对应等待队列，避免 fast-path 绕过已有等待者。
- `acquireGlobalAgentSlot` 增加 `onAcquired(slotId)` 回调，在 Lua 返回成功后同步更新 pending 对象。
- `acquireGlobalAgentSlot` 保留 `shouldContinue`，并在拿到槽位后再次检查。如果请求已经超时或取消，立即释放槽位并抛错。
- timeout handler 释放槽位时使用 `pending?.concurrencySlotId ?? concurrencySlotId`。
- enqueue payload 前检查 pending 是否仍存在；不存在则释放槽位和本地 agent lease，并停止提交。

### 测试要求

在 `apps/api/tests/runtime/ipc-worker.test.ts` 增加或调整用例：

- 会员队列永远优先于普通队列。
- 普通请求不会绕过已存在的普通等待队列。
- Lua 返回 `not_turn` 时不会写 inbox payload。
- Lua 返回成功后 pending 立即拥有 `concurrencySlotId`。
- timeout 在槽位获取窗口发生时仍会调用 `zrem`。
- pending 被 timeout 删除后，提交流程不会继续 enqueue payload。

## Redis IPC listener 生命周期

涉及文件：

- `apps/api/src/runtime/ipc-worker.ts`
- `apps/api/tests/runtime/ipc-worker.test.ts`

覆盖 review 项：

- #5 listenForAccount 异常退出不自动重启

### 当前问题

`startIpcWorker` 和 `addAccountListener` 直接调用 `listenForAccount(accountId).catch(...)`。当 `listenForAccount` 因 Redis 异常、连接永久断开或不可恢复错误退出时，当前 account 的 outbox 队列不再被消费。

### 修复设计

增加 listener supervisor：

- 新增 `desiredAccountListeners = new Set<string>()` 记录应该保持运行的 account。
- `startIpcWorker` 和 `addAccountListener` 把 accountId 加入 desired set，再启动 `listenForAccountWithRestart(accountId)`。
- `removeAccountListener` 从 desired set 删除 accountId，并把当前 listener 的 `running` 置为 false。
- `listenForAccountWithRestart` 循环调用 `listenForAccount`。异常退出时记录结构化日志并使用指数退避。
- 人为停止时不重启。
- 退避参数使用常量，例如初始 1 秒，上限 30 秒。
- 成功运行一段时间后重置失败计数，避免一次历史故障导致日志长期显示高 retry count。

### 测试要求

- listener 异常 reject 后会重新调用 `listenForAccount`。
- `removeAccountListener` 后不会重启。
- repeated `addAccountListener` 不会启动多个 supervisor。
- `_resetIpcWorkerForTests` 清空 desired set 和 listener map。

## WebSocket 流式连接

涉及文件：

- `apps/api/src/runtime/ai-chat-stream.ts`
- `apps/api/tests/runtime/ai-chat-stream.test.ts`

覆盖 review 项：

- #3 WebSocket frameBuffer 无界增长
- #7 WebSocket 无心跳/空闲超时

### 当前问题

`frameBuffer = Buffer.concat([frameBuffer, chunk])` 没有大小限制。客户端可以持续发送无法解析完整帧的数据，使 buffer 不断增长。

服务端也没有主动 ping/pong 或 idle timeout。半开连接会保留 socket 与 Redis subscriber。

### 修复设计

新增常量：

```ts
const MAX_CLIENT_FRAME_BUFFER_BYTES = 1024 * 1024;
const WS_PING_INTERVAL_MS = 30_000;
const WS_PONG_TIMEOUT_MS = 60_000;
```

输入 buffer 防护：

- 拼接前检查 `frameBuffer.length + chunk.length`。
- 超限时发送 close frame：code `1009`，reason `frame too large`。
- 在 `parseClientFrames` 中解析到扩展长度后，如果 declared payload length 超过 `MAX_CLIENT_FRAME_BUFFER_BYTES`，直接要求关闭。
- 对异常协议帧可以使用 close code `1002`。

心跳机制：

- `lastPongAt = Date.now()`。
- 定时发送 ping frame opcode `0x9`。
- `parseClientFrames` 识别 pong opcode `0xa` 并更新 `lastPongAt`。
- 当前时间与 `lastPongAt` 差值超过 `WS_PONG_TIMEOUT_MS` 时关闭连接。
- `close()` 中清理 ping timer，并确保 `subscriber.quit()` 只执行一次。

### 测试要求

- 超过 `MAX_CLIENT_FRAME_BUFFER_BYTES` 的客户端数据会关闭连接并释放 subscriber。
- 声明超大 payload length 的帧不会等待完整 payload。
- 收到 ping 会回复 pong。
- 收到 pong 会刷新 `lastPongAt`。
- pong 超时会关闭 socket。

## iLink 轮询消息处理

涉及文件：

- `apps/api/src/runtime/poller.ts`
- 对应新增或现有 poller 测试文件

覆盖 review 项：

- #6 iLink 轮询消息无并发控制

### 当前问题

轮询拿到消息后直接 fire-and-forget 调用 `processWeixinMessage`。大量消息会同时进入 LLM、DB、全局并发槽位等下游路径。

### 修复设计

为每个 account 增加有界执行器：

- `MAX_WEIXIN_MESSAGE_CONCURRENCY_PER_ACCOUNT = 3`
- `MAX_WEIXIN_MESSAGE_BACKLOG_PER_ACCOUNT = 100`
- 使用 `Map<string, AccountMessageLimiter>` 保存 account 级 limiter。
- active 数量未满时立即执行。
- active 已满但 backlog 未满时进入队列。
- backlog 已满时记录 warn 和 metrics。是否丢弃消息、延迟处理或回复“系统繁忙”由产品策略决定；代码上必须显式可观测。
- `stopAccountPolling` 调用时停止接收新任务，并清理该 account 的 limiter。

### 测试要求

- 同一 account 同时运行的 `processWeixinMessage` 不超过配置值。
- 不同 account 之间互不阻塞。
- backlog 超限时有日志或指标。
- 任务完成后队列中的下一条会被调度。

## Admin 用户列表

涉及文件：

- `apps/api/src/modules/admin/admin-service.ts`
- `apps/api/src/interfaces/http/admin-routes.ts`
- `apps/api/src/infrastructure/repositories/users-repository.ts`
- `apps/api/src/infrastructure/repositories/accounts-repository.ts`
- `apps/api/src/infrastructure/repositories/billing-repository.ts`
- `apps/admin/lib/admin-api.ts`
- `apps/admin/app/(dashboard)/users/page.tsx`
- `apps/api/tests/modules/admin/admin-service.test.ts`
- `apps/api/tests/interfaces/http/admin-routes.test.ts`

覆盖 review 项：

- #4 Admin 用户列表 N+1 查询

### 当前问题

`listAdminUsersWithStats()` 当前：

- `getAllUsers()` 全量加载用户。
- 对每个用户并发查询账号、usage、monthly billing、wallet、membership。
- 前端 `admin.users()` 也假设一次加载全部用户，并在客户端搜索过滤。

### 修复设计

API contract 改为分页结果：

```ts
interface AdminUsersPageResult {
  items: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}
```

HTTP 参数：

- `page`: 默认 1，最小 1。
- `page_size`: 默认 50，范围 1-100。
- `q`: 可选，按手机号或 user id 搜索。

后端查询方式：

- 查询当前页 users，并同时得到 total。
- 基于当前页 `userIds` 批量查询账号数：
  - `SELECT owner_id, COUNT(*) FROM accounts WHERE owner_id = ANY($1) GROUP BY owner_id`
- 批量查询总用量和当月/今日 usage：
  - 使用 `daily_usage WHERE user_id = ANY($1)` 聚合。
- 批量查询月计费：
  - `monthly_billing_state WHERE user_id = ANY($1) AND year_month = $2`
- wallet 字段直接来自 users 表，不需要再逐用户 `getUserById`。
- 会员状态批量查询当前有效会员、allowance、configs，再在 service 层组装为 `MembershipStatusDto`。

前端调整：

- `admin.users(params)` 返回分页结果。
- 用户页搜索触发服务端查询。
- 用户列表页展示分页控件。
- 当前页 summary 只展示当前查询结果；如果需要全局 summary，改用已有 overview/statistics 接口，不从用户列表聚合。

兼容策略：

- 如果短期不想改变前端 contract，可以保留 `GET /api/admin/users` 默认返回分页第一页，并新增 `GET /api/admin/users/export` 用于全量导出。

### 测试要求

- admin users API 校验 page/page_size/q。
- service 查询用户数为 N 时，DB 查询次数不随 N 线性增长到每用户多次。
- 搜索手机号和 user id 正常。
- 前端空列表、加载态、翻页、刷新行为正常。

## 计费与结算

涉及文件：

- `apps/api/src/modules/billing/plans.ts`
- `apps/api/src/infrastructure/repositories/billing-repository.ts`
- `apps/api/tests/modules/billing/plans.test.ts`
- `apps/api/tests/infrastructure/repositories/billing-repository.test.ts`

覆盖 review 项：

- #8 计费预留金额恒为 0
- #9 结算记录缺失时静默返回 0 费用

### 当前问题

当前 repository 注释和测试明确表示：请求开始不冻结余额，结束后按真实 token 成本入账，允许把充值积分扣成负数。这个设计会允许并发请求在结算前通过入口检查。

无论采用预付费还是后付费，reservation 缺失时静默返回 0 都不可接受，因为这会让收入损失没有日志和指标。

### 计费策略选项

#### 后付费/可欠费模型

保留 `amountCoins: 0`，但把语义写清楚：

- `reserveBillingForRequest` 改名或补充注释，表达“登记待结算记录”而不是“冻结余额”。
- 用户欠费拦截保留在新请求入口。
- 增加信用额度配置，例如 `MAX_USER_ARREARS_COINS`。
- 入口检查从 `balance < 0` 扩展为 `balance <= -MAX_USER_ARREARS_COINS`。
- 对短时间大量并发请求增加用户级 in-flight metered request 上限。

#### 预付费硬门禁模型

恢复真实冻结：

- 根据 `maxOutputTokens`、输入预算、模型输入/输出单价估算 `estimatedReserveCoins`。
- `reserveUserBalanceCoins` 实际写入 `reserved_coins`，reservation `hold_state = 'held'`。
- 请求结束时使用真实 token 成本结算，多退少补。
- 请求失败、取消、timeout 时释放 reservation。
- 余额不足时入口返回 402。

### reservation 缺失修复

`settleBillingReservationDetailed` 在 metered runtime 且找不到 reservation 时：

- 记录 `logger.warn({ requestId, modelConfigId, runtimeSource }, ...)`。
- 增加 metrics，例如 `billing.settlement_missing_reservation`。
- 返回值中增加 `missingReservation: true`，供调用方记录更明确的业务日志。
- 可选扩展：结算函数增加 `ownerUserId` 参数，缺失 reservation 时写入补偿表 `billing_settlement_anomalies`，用于后台人工对账。

### 测试要求

- 后付费模型：0 预留行为被明确测试为“登记记录，不冻结余额”。
- 预付费模型：余额不足会拒绝请求，取消/失败/timeout 会释放冻结金额。
- reservation 缺失时必须产生 warn 和 metrics。
- 重复结算保持幂等。

## IPC payload accountId 解析

涉及文件：

- `apps/api/src/runtime/ipc-payloads.ts`
- `apps/api/tests/runtime/ipc-outbox-handler.test.ts`
- `apps/api/tests/runtime/ipc-ai-chat-outbox-handler.test.ts`

覆盖 review 项：

- #10 `resolveAccountId` 退化为全表扫描

### 当前问题

`resolveAccountId` 在 explicit 和 fallback 都没有时调用 `getAllAccounts()`，会加载整个 accounts 表。正常 listener 调用会传 `fallbackAccountId`，因此它主要是兜底路径问题。

### 修复设计

新增 repository 函数：

```ts
export async function getSingleAccountIdIfOnlyOne(): Promise<string | null> {
  const rows = await query('SELECT id FROM accounts ORDER BY created_at LIMIT 2');
  return rows.length === 1 ? rows[0].id : null;
}
```

`resolveAccountId` 改为调用该函数，不再加载完整 account row。

### 测试要求

- explicit accountId 优先。
- fallback accountId 次之。
- 只有一个账号时返回该账号 id。
- 0 个或多个账号时返回 null。
- 不调用 `getAllAccounts`。

## daily_usage 月查询

涉及文件：

- `apps/api/src/infrastructure/daily-usage.ts`
- `apps/api/tests/infrastructure/daily-usage.test.ts`

覆盖 review 项：

- #11 `getMonthlyTokenUsage` 使用 `LIKE`

### 当前问题

`daily_usage.date` 是 ISO 日期文本，主键为 `(user_id, date)`。`date LIKE 'YYYY-MM%'` 可以利用 `user_id` 过滤，但对 `date` 范围不如 btree range 条件明确。

### 修复设计

新增月份边界函数：

```ts
function resolveMonthRange(yearMonth: string): { start: string; end: string } {
  // 输入 YYYY-MM，输出 YYYY-MM-01 和下个月 YYYY-MM-01。
}
```

查询改为：

```sql
WHERE user_id = $1
  AND date >= $2
  AND date < $3
```

同步修改 `getUsageStats` 中的 monthly message 查询。

### 测试要求

- 2026-06 能匹配 2026-06-01 到 2026-06-30。
- 不匹配 2026-07-01。
- 2026-12 的 end 正确变为 2027-01-01。

## agent-runtime daemon

涉及文件：

- `apps/agent-runtime/src/daemon.ts`
- `apps/agent-runtime/tests/daemon.test.ts`

覆盖 review 项：

- #12 daemon 单线程串行处理
- #13 `pendingCancelRequests` Set 无清理机制

### 单账号串行处理

当前 daemon 在 `brpop` 拿到一条 inbox 后等待 `processInboxMessage` 完成，因此同一 account 下请求串行执行。该行为可能是吞吐瓶颈，但并发化需要确认 runtime 内部状态是否完全 request-scoped。

修复设计：

- 把 `inFlight: Promise<void> | null` 改为 `activeTasks = new Map<requestId, Promise<void>>()`。
- 增加 `AGENT_RUNTIME_ACCOUNT_CONCURRENCY`，默认 1，允许配置到 2-3。
- `brpop` 循环在 active 数量达到上限时暂停拉取新 inbox。
- cancel drain 循环持续运行，面向所有 active sessions。
- shutdown 时等待所有 active tasks，超时后退出。
- `activeSessions` 继续按 requestId 保存 sessionControls。

约束：

- `executeContainerInput`、trace、transcript、artifact、request scope 必须确认没有共享可变全局状态。
- 若存在 account 级不可并发资源，应保持默认 1，仅通过多进程或多 account 扩容。

### cancel TTL

`pendingCancelRequests` 从 `Set<string>` 改为 `Map<string, number>`：

- 收到未匹配 cancel 时记录当前时间。
- `onSessionReady` 检查 map 中是否存在 requestId，存在则删除并 abort。
- 每次 drain 或固定 interval 清理超过 35 分钟的记录。

### 测试要求

- 未匹配 cancel 会写入 Map。
- session ready 时能消费 pending cancel。
- 超过 TTL 的 cancel 会被清理。
- 并发配置为 1 时保持现有串行行为。
- 并发配置大于 1 时 active tasks 不超过上限。

## trace 字段截断

涉及文件：

- `apps/agent-runtime/src/request-scope.ts`
- `apps/agent-runtime/tests/request-boundary.test.ts` 或新增 request-scope 测试

覆盖 review 项：

- #14 `truncateStringFields` 截断计算对多字节字符不精确

### 当前问题

当前算法使用整体字节比例估算字符切割位置：

```ts
const ratio = TRACE_FIELD_TRUNCATE_BYTES / byteLen;
const cut = Math.floor(value.length * ratio);
```

如果字符串前半段多字节字符密集、后半段 ASCII 密集，切出的前缀可能超过目标字节数。

### 修复设计

使用二分查找得到最大安全前缀：

```ts
function sliceUtf8ByByteLimit(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return value.slice(0, low);
}
```

注意事项：

- 避免把 surrogate pair 切坏。可以在得到 cut 后，如果 `cut` 落在低代理项前，回退一个 code unit。
- truncated 后缀本身也占字节。若要求最终字段整体不超过 4KB，需要把后缀长度从 maxBytes 中扣除。

### 测试要求

- 纯 ASCII。
- 纯中文。
- 中文前缀加 ASCII 后缀。
- emoji/surrogate pair。
- 嵌套 object 和 array 字段都会递归截断。

## output token policy

涉及文件：

- `apps/agent-runtime/src/output-token-policy.ts`
- `apps/agent-runtime/src/pi-runtime/provider.ts`
- `apps/api/src/shared/output-token-policy.ts`
- `apps/api/src/modules/system/system-config.ts`
- 相关 model/context-window 测试

覆盖 review 项：

- #15 API 与 agent-runtime 两侧 maxOutputTokens 计算不一致

### 当前判断

主路径不成立。API 侧 `resolveUserLlmRuntime` 会根据配置后的 `contextWindowTokens` 计算 `maxOutputTokens`，并通过 IPC payload 传入 agent-runtime。agent-runtime provider 注册时使用 `runtime.maxOutputTokens ?? 16_384`，不会在主路径重新调用自己的 fallback。

### 修复设计

清理方案：

- 如果 `apps/agent-runtime/src/output-token-policy.ts` 没有调用点，删除该文件或标记为测试/历史兼容用途。
- 如果需要保留 fallback，把函数签名改成与 API 一致：

```ts
export function getDefaultMaxOutputTokens(
  model: string,
  contextWindowTokens?: number | null,
): number
```

- 增加测试证明 API 计算出的 `maxOutputTokens` 会进入 `createPiProviderRuntime` 的 `model.maxTokens`。

### 测试要求

- 自定义 context window 下，API runtime snapshot 的 `maxOutputTokens` 符合预期。
- agent-runtime provider 使用 payload 中的 `maxOutputTokens`。
- payload 缺失 `maxOutputTokens` 时 fallback 行为明确。

## retention worker

涉及文件：

- `apps/api/src/runtime/retention.ts`
- 相关 retention 测试

覆盖 review 项：

- #16 retention timer 未 `unref`

### 当前问题

`startRetentionWorker` 创建的 interval 没有 `unref()`。主应用关停路径会调用 `stopRetentionWorker()`，但测试或局部启动场景中 interval 可能阻止进程退出。

### 修复设计

```ts
retentionTimer = setInterval(() => {
  runRetentionOnce().catch(() => {
    /* 错误已在 runRetentionOnce 内部 logger.warn */
  });
}, RETENTION_INTERVAL_MS);
retentionTimer.unref();
```

### 测试要求

- `startRetentionWorker` 重复调用不会创建多个 timer。
- `stopRetentionWorker` 能 clear timer。
- timer 对象调用过 `unref`。

## 验证命令

后端：

```bash
pnpm --filter @fateclaw/api test
pnpm --filter @fateclaw/api typecheck
pnpm --filter @fateclaw/api lint
```

agent-runtime：

```bash
pnpm test apps/agent-runtime/tests/daemon.test.ts apps/agent-runtime/tests/request-boundary.test.ts
pnpm run build:agent-runtime
```

Admin 前端：

```bash
pnpm --filter fateclaw-admin build
```

全量回归：

```bash
pnpm test
pnpm run build:backend
```

## 交付检查清单

- 全局并发队列不存在非原子 `lindex` + `rpop` 抢占路径。
- 槽位只要进入 active zset，就能被 timeout/cancel/error 路径释放。
- pending 已删除的请求不会继续写入 inbox。
- WebSocket 客户端输入 buffer 有上限。
- WebSocket 僵尸连接会被心跳关闭。
- Redis IPC listener 异常退出后可恢复，人工移除 listener 不会被误恢复。
- iLink 单账号消息处理有并发上限和 backlog 上限。
- Admin 用户列表不再全量加载和逐用户多查询。
- 计费模型是明确的后付费或预付费，不再语义混乱。
- reservation 缺失有日志、指标或异常表记录。
- `resolveAccountId` 兜底不再加载全 accounts 表。
- 月查询使用范围条件。
- agent-runtime cancel pending 有 TTL。
- trace 截断按 UTF-8 字节安全计算。
- output token fallback 与主路径语义一致。
- retention interval 不阻止进程退出。
