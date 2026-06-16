# 深度扫描报告：apps/agent-runtime/ 与 apps/api/

> **日期:** 2026-06-16  
> **扫描范围:** `apps/agent-runtime/` 全部源码，`apps/api/src/` 全部源码  
> **方法:** 静态分析 + 逻辑推演，聚焦严重逻辑错误与性能瓶颈

---

## 概览

| 严重度 | 数量 | 说明 |
|--------|------|------|
| 🔴 Critical | 3 | 必须修复，存在数据丢失/服务不可用/安全风险 |
| 🟠 High | 6 | 尽快修复，生产环境可能暴露 |
| 🟡 Medium | 7 | 计划修复，随数据增长逐步退化 |

---

## 🔴 Critical — 必须修复

### 1. 全局并发槽位等待队列竞态条件（可致请求永久饥饿）

**文件:** `apps/api/src/runtime/ipc-worker.ts` L177-258  
**类型:** 逻辑错误 / 竞态条件

**问题代码:**

```ts
// L177: 只 peek 不 pop
async function dequeueGlobalAgentWaiter(): Promise<string | null> {
  return (
    (await getRedis().lindex(GLOBAL_AGENT_MEMBER_WAIT_QUEUE, -1)) ??
    (await getRedis().lindex(GLOBAL_AGENT_NORMAL_WAIT_QUEUE, -1))
  );
}

// L244-256: 非原子的 peek → 抢占 → pop 序列
const nextRequestId = await dequeueGlobalAgentWaiter();
if (nextRequestId !== input.requestId) { continue; }
if (await tryAcquireGlobalAgentSlot(...)) {
  await getRedis().rpop(queue);  // 此时队尾可能已不是自己
  return input.requestId;
}
```

**分析:**

`lindex`（只读）+ 条件 `rpop`（删除）之间存在 TOCTOU（Time-of-Check-to-Time-of-Use）窗口。多实例部署或高并发时：

1. 实例 A 调用 `lindex` 看到自己在队尾
2. 实例 B 也调用 `lindex` 看到 A 在队尾（A 还没 pop）
3. A 获取槽位并 `rpop`（正确移除了 A）
4. B 的 `rpop` 移除了错误的元素（现在队尾变成了 B 自己或下一个请求）

**影响:** 某些请求可能永远留在队列中，直到 30 分钟超时。系统在高并发下出现请求饥饿。

**修复方向:** 用 Lua 脚本将检查+弹出合并为原子操作：

```lua
local val = redis.call('LINDEX', KEYS[1], -1)
if val == ARGV[1] then
  return redis.call('RPOP', KEYS[1])
end
return nil
```

---

### 2. 并发槽位 ID 赋值时序窗口（可致槽位泄漏 → 系统瘫痪）

**文件:** `apps/api/src/runtime/ipc-worker.ts` L580-605, L854-879  
**类型:** 逻辑错误 / 资源泄漏

**问题代码:**

```ts
pendingInboxRequests.set(requestId, {
  concurrencySlotId,          // ← 此时为 undefined
  // ...
});

// acquireGlobalAgentSlot 可能等待数十秒
concurrencySlotId = await acquireGlobalAgentSlot({...});

// 事后补丁
const pendingAfterSlot = pendingInboxRequests.get(requestId);
if (pendingAfterSlot) {
  pendingAfterSlot.concurrencySlotId = concurrencySlotId;
}
```

**分析:**

在 `acquireGlobalAgentSlot` 等待期间（可能等数十秒甚至更久），如果 timeout 触发：

```ts
timeout = setTimeout(async () => {
  const pending = pendingInboxRequests.get(requestId);
  void releaseGlobalAgentSlot(pending?.concurrencySlotId); // undefined → no-op! 槽位泄漏！
});
```

**影响:** 已获取的槽位不会被释放。随着泄漏累积，全局并发上限被逐步耗尽，最终所有新请求永远排队。这是一个渐进式系统瘫痪——可能数小时或数天后才暴露。

**修复方向:** timeout handler 中直接引用闭包变量 `concurrencySlotId`，或在 `acquireGlobalAgentSlot` 内部注册清理逻辑：

```ts
// 方案 A：闭包引用
timeout = setTimeout(async () => {
  void releaseGlobalAgentSlot(concurrencySlotId); // 闭包中的变量已被赋值
});

// 方案 B：acquireGlobalAgentSlot 支持 AbortSignal
concurrencySlotId = await acquireGlobalAgentSlot({
  requestId,
  priority,
  signal: abortController.signal,  // timeout 时 abort
});
```

---

### 3. WebSocket frameBuffer 无界增长（DoS 向量）

**文件:** `apps/api/src/runtime/ai-chat-stream.ts` L579-587  
**类型:** 安全 / 资源泄漏

**问题代码:**

```ts
socket.on('data', (chunk) => {
  frameBuffer = Buffer.concat([frameBuffer, chunk]);
  const result = parseClientFrames(frameBuffer, socket);
  frameBuffer = frameBuffer.subarray(result.consumed);
  if (result.closeRequested) {
    writeCloseFrame(socket);
    void close();
  }
});
```

**分析:**

恶意客户端发送不完整帧（如只发 1 字节头部声称帧长度为 64KB，但永远不发后续数据），`parseClientFrames` 因帧不完整返回 `consumed: 0`，`frameBuffer` 只增不减。这是经典的 Slow-Loris 攻击变体。

**影响:** 单个恶意连接可以消耗服务端任意内存，最终导致进程 OOM 崩溃。

**修复方向:**

```ts
const MAX_FRAME_BUFFER = 1024 * 1024; // 1MB

socket.on('data', (chunk) => {
  frameBuffer = Buffer.concat([frameBuffer, chunk]);
  if (frameBuffer.length > MAX_FRAME_BUFFER) {
    writeCloseFrame(socket, 1009, 'frame too large');
    void close();
    return;
  }
  const result = parseClientFrames(frameBuffer, socket);
  frameBuffer = frameBuffer.subarray(result.consumed);
  if (result.closeRequested) {
    writeCloseFrame(socket);
    void close();
  }
});
```

---

## 🟠 High — 尽快修复

### 4. Admin 用户列表 N+1 查询

**文件:** `apps/api/src/modules/admin/admin-service.ts` ~L1094-1118  
**类型:** 性能瓶颈

**问题:** `listAdminUsersWithStats()` 先 `getAllUsers()` 加载全部用户到内存，然后对每个用户发起 5 个并行 DB 查询（会员状态、用量统计等）。

**影响:** 1000 用户 = 5000 个并发查询，可能耗尽 DB 连接池，导致全站 DB 响应变慢。

**修复方向:** 分页 + 批量聚合 JOIN，或 chunk 分批查询（每批 20 用户）。

---

### 5. listenForAccount 异常退出不自动重启

**文件:** `apps/api/src/runtime/ipc-worker.ts` L691-695  
**类型:** 逻辑错误 / 可用性

**问题代码:**

```ts
for (const accountId of enabledAccountIds) {
  listenForAccount(accountId).catch((err) => {
    logger.error({ accountId, err }, 'Redis IPC 监听异常退出');
    // 不重启！该 account 的 outbox 永远不会被消费
  });
}
```

**影响:** listener 因 Redis 连接永久断开等异常退出后，该 account 的所有 outbox 消息永远不会被处理。所有 pending 请求挂到 30 分钟超时后静默失败，用户完全无感知。

**修复方向:**

```ts
async function listenForAccountWithRestart(accountId: string): Promise<void> {
  const MAX_RETRIES = 10;
  let retries = 0;
  while (retries < MAX_RETRIES) {
    try {
      await listenForAccount(accountId);
      return; // 正常退出（running=false）
    } catch (err) {
      retries += 1;
      const backoff = Math.min(30_000, 1000 * Math.pow(2, retries));
      logger.error({ accountId, err, retries, backoff }, 'Redis IPC 监听异常退出，即将重启');
      await delay(backoff);
    }
  }
  logger.error({ accountId }, 'Redis IPC 监听重试次数耗尽，放弃');
}
```

---

### 6. iLink 轮询消息无并发控制

**文件:** `apps/api/src/runtime/poller.ts` L91-95  
**类型:** 性能瓶颈 / 可用性

**问题代码:**

```ts
for (const msg of resp.msgs) {
  if (msg.message_type === 1) {
    void processWeixinMessage(account, msg).catch((err) => {
      log.error({ err, msgId: msg.message_id }, '消息处理失败');
    });
  }
}
```

**影响:** 微信群消息风暴时，所有消息并发处理（无上限），每条触发：LLM 请求 + DB 写入 + 并发槽位占用。瞬间打满全局并发上限，其他正常用户被阻塞。

**修复方向:** 使用 semaphore 限制每 account 并发数：

```ts
const MAX_CONCURRENT_PER_ACCOUNT = 3;
const semaphore = new Map<string, number>();

// 处理消息前检查
if ((semaphore.get(account.id) ?? 0) >= MAX_CONCURRENT_PER_ACCOUNT) {
  log.warn({ accountId: account.id }, '消息并发已满，丢弃');
  continue;
}
```

---

### 7. WebSocket 无心跳/空闲超时

**文件:** `apps/api/src/runtime/ai-chat-stream.ts` L568-617  
**类型:** 资源泄漏

**问题:** 每个 WebSocket 连接创建一个 Redis subscriber 连接。没有 ping/pong 检测或空闲超时。

**影响:** 僵尸连接（客户端异常关闭浏览器但 TCP 未正常 FIN）会让 Redis subscriber 永远存活。大量僵尸连接最终耗尽 Redis 连接数上限。

**修复方向:** 添加 30s ping 间隔 + 60s pong 超时：

```ts
const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 60_000;
let lastPong = Date.now();

const pingTimer = setInterval(() => {
  writeFrame(socket, 0x9, Buffer.alloc(0)); // ping
  if (Date.now() - lastPong > PONG_TIMEOUT) {
    void close();
  }
}, PING_INTERVAL);
```

---

### 8. 计费预留金额恒为 0（并发透支）

**文件:** `apps/api/src/modules/billing/plans.ts` L106-144  
**类型:** 逻辑错误

**问题代码:**

```ts
const reservation = await reserveUserBalanceCoins({
  userId: input.userId,
  amountCoins: 0,  // ← 预留金额恒为 0！
  requestId: input.requestId,
  // ...
});
```

**分析:** 预留机制只登记一条记录但不实际冻结任何积分。`reserveBillingForRequest` 的"预留"形同虚设。

**影响:** 余额 1 积分的用户可以同时发起 100 个请求，全部通过余额检查。所有请求完成后才结算，可能产生大量欠费。

**修复方向:** 预估单次请求最大消费（基于模型价格和 maxOutputTokens），实际冻结该金额。请求完成后用实际用量结算差额。

---

### 9. 结算记录缺失时静默返回 0 费用

**文件:** `apps/api/src/modules/billing/plans.ts` L163-172  
**类型:** 逻辑错误

**问题代码:**

```ts
const reservation = await getBillingRequestReservationByRequestId(input.requestId);
if (!reservation) {
  return { actualChargeCoins: 0, rawChargeCoins: 0, ... };  // 免费！无日志！
}
```

**影响:** DB 故障或竞态导致预留记录丢失时，用户免费获得 AI 服务，且没有任何告警日志。运维无法感知收入损失。

**修复方向:** 添加 warn 日志 + 指标上报：

```ts
if (!reservation) {
  logger.warn({ requestId: input.requestId }, '结算时未找到预留记录，跳过扣费');
  // metrics.increment('billing.settlement_missing_reservation');
  return { actualChargeCoins: 0, ... };
}
```

---

## 🟡 Medium — 计划修复

### 10. resolveAccountId 退化为全表扫描

**文件:** `apps/api/src/runtime/ipc-payloads.ts` L300-318  
**类型:** 性能瓶颈

当 `payload.accountId` 和 `fallbackAccountId` 都为空时，调用 `getAllAccounts()` 查整个 accounts 表。每条 IPC 消息处理路径都可能触发。

**修复:** 改为 `SELECT id FROM accounts LIMIT 2`，只需判断是否恰好一条记录。

---

### 11. getMonthlyTokenUsage 使用 LIKE 阻止索引

**文件:** `apps/api/src/infrastructure/daily-usage.ts` ~L162  
**类型:** 性能瓶颈

`date LIKE '2026-06%'` 无法使用 btree 索引。此函数在每次 AI 请求的计费路径中被调用。

**修复:** 改为范围查询：

```sql
WHERE date >= '2026-06-01' AND date < '2026-07-01'
```

---

### 12. agent-runtime daemon 单线程串行处理

**文件:** `apps/agent-runtime/dist/daemon.js` L264-295  
**类型:** 性能瓶颈

daemon 主循环每次只处理一条 inbox 消息，下一条必须等前一条完成。单个 account 的所有请求被串行化。

**影响:** 一个 30 分钟请求阻塞后续所有该 account 的请求。

**修复方向:** 允许有限并发（如同时处理 2-3 条），或拆分为 worker pool 模式。

---

### 13. pendingCancelRequests Set 无清理机制

**文件:** `apps/agent-runtime/dist/daemon.js` L88  
**类型:** 资源泄漏

从未被匹配处理的 cancel requestId 会永久留在 Set 中。长运行 daemon 逐步内存膨胀。

**修复:** 添加 TTL 机制，超过 N 分钟的条目自动清除：

```ts
// 用 Map<requestId, timestamp> 替代 Set
pendingCancelRequests.set(cancelRequest.requestId, Date.now());

// 定期清理超过 35 分钟的条目
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of pendingCancelRequests) {
    if (now - ts > 35 * 60 * 1000) pendingCancelRequests.delete(id);
  }
}, 60_000);
```

---

### 14. truncateStringFields 截断计算对多字节字符不精确

**文件:** `apps/agent-runtime/dist/request-scope.js` L20-21  
**类型:** 逻辑错误（轻微）

```js
const ratio = TRACE_FIELD_TRUNCATE_BYTES / byteLen;
const cut = Math.floor(value.length * ratio);
```

用字节比率乘以字符长度。中文字符（3 字节/字符）场景下，截断后的实际字节数可能是预期的 2-3 倍。

**修复:** 使用 `Buffer.byteLength(value.slice(0, cut))` 验证并迭代调整，或使用二分查找。

---

### 15. API 与 agent-runtime 两侧 maxOutputTokens 计算不一致

**文件:** `apps/api/src/shared/output-token-policy.ts` vs `apps/agent-runtime/dist/model-context-window.js`  
**类型:** 数据一致性

API 侧 `getDefaultMaxOutputTokens(model, contextWindowTokens?)` 接受用户自配的上下文窗口大小；agent-runtime 侧 `getDefaultMaxOutputTokens(model)` 只接受 model 参数，忽略用户自配值。

**影响:** 用户配置自定义上下文窗口后，API 侧预留的输出空间与容器侧实际设定的 max_tokens 不匹配，可能导致意外截断或浪费。

---

### 16. retention.ts timer 未 unref

**文件:** `apps/api/src/runtime/retention.ts` L59  
**类型:** 生命周期管理

`setInterval` 返回的 timer 未调用 `.unref()`，会阻止 Node.js 进程优雅退出。必须显式调用 `stopRetentionWorker()` 才能退出。

---

## 优先修复排期建议

| 优先级 | 问题编号 | 问题描述 | 预估影响 | 修复难度 |
|--------|---------|----------|----------|----------|
| **P0** | #1 | 并发队列竞态 | 多实例下请求饥饿 | 中（Lua 脚本） |
| **P0** | #2 | 槽位 ID 时序窗口 | 系统逐步不可用 | 低（闭包引用） |
| **P0** | #3 | frameBuffer DoS | 外部可利用攻击面 | 低（加上限） |
| **P1** | #4 | Admin N+1 查询 | DB 连接池耗尽 | 中（重写查询） |
| **P1** | #5 | listener 不重启 | 账号级服务中断 | 低（重试逻辑） |
| **P1** | #6 | 轮询无并发控制 | 突发流量雪崩 | 低（semaphore） |
| **P1** | #7 | WebSocket 无超时 | Redis 连接累积 | 中（心跳机制） |
| **P1** | #8 | 计费预留为 0 | 并发透支 | 中（预估冻结） |
| **P1** | #9 | 结算静默跳过 | 收入损失 | 低（加日志） |
| **P2** | #10 | resolveAccountId | 异常路径慢查询 | 低 |
| **P2** | #11 | LIKE 阻止索引 | 随数据增长变慢 | 低 |
| **P2** | #12 | daemon 串行 | 单 account 吞吐 | 高（架构调整） |
| **P2** | #13 | cancel Set 泄漏 | 长期内存膨胀 | 低 |
| **P2** | #14 | 截断精度 | trace 体积偏大 | 低 |
| **P2** | #15 | output token 不一致 | 参数漂移 | 低 |
| **P2** | #16 | timer 未 unref | 退出延迟 | 低 |

---

## 附录：扫描方法

- 静态代码阅读全部 `apps/agent-runtime/dist/*.js` 源码（编译产物，对应 TypeScript 源码）
- 静态代码阅读全部 `apps/api/src/` 下 runtime、shared、modules、infrastructure 层源码
- 重点关注：竞态条件、资源泄漏、无界增长、原子性缺失、错误处理遗漏
- 不涉及运行时 profiling 或负载测试
