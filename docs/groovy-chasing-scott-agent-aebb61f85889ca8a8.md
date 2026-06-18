# FateClaw 付费深度报告 (Paid Deep Report) — 实现蓝图

> 复用现有 chat-session + WebSocket 推流 + 钱包扣费 + 排盘 runtime；新增 report_presets/report_orders + 报告编排器 + 链式分章生成。

## 0. 核心架构决策 (已验证落点)

| 关注点 | 复用现有 | 新建 |
|---|---|---|
| 报告展示 | chat_sessions + messages + `publishAiChatStreamEvent` 推流 | — |
| 排盘 | `executeDirectPaipan()` (paipan-runtime.ts:329) | — |
| 单章 AI 生成 | `sendOwnedChatSessionMessage(...overrides)` (chat-session-service.ts:734) | report 专用 quota/billing bypass |
| 扣费/退款 | `deductBalanceCoins()` (billing-repo:3020) | `purchaseReportWithWallet()` / `refundReportOrder()` |
| 订单状态机 | `settleRechargeOrderPaid()` 幂等模板 (billing-repo:2492) | `report_orders` 表 |
| 配置 | `getMembershipConfig/update` + `simple_workflow_presets` 模板 | `report_presets` 表 |
| 章节链式触发 | outbox handler `processAiChatResponse` (ipc-ai-chat-outbox-handler.ts:549) | 章节推进钩子 (DB 驱动) |

**关键发现 / 风险 (务必先读)**

1. **双重扣费风险 (HIGH)**：官方模型 runtime `billingMode:'metered'` (system-config.ts:468/617)，每章 AI turn 会经 `settleAiChatBilling` 再次按 token 扣钱包。报告价格是固定一口价，token 成本必须吸收进报告价。
   - **解法**：报告章节 turn 的 llmRuntime override 设 `billingMode:'none'`。已验证 `reserveBillingForRequest`/settle 在 `billingMode!=='metered'` 时短路 (plans.ts:129/175) → 不预留、不结算、零 token 扣费。报告章节走 none。

2. **IPC 请求不回传自定义 metadata (关键约束)**：`dispatchAiChatPrompt`/`submitAiChatInboxRequest` 不接受 request 级 metadata，response payload 也不带回 `report_order_id`/`chapter_index`。`sourceMetadata` 只落在 user message 上，不进 IPC。
   - **解法**：章节链式推进**不依赖** response metadata，而是 outbox handler 用 `pending.sessionId` 反查 `report_orders` (DB 为唯一真相)。`pending.sessionId` + `pending.userMessageId` 在 response 里可靠存在 (ipc-payloads.ts:128 / ipc-worker.ts:982)。

3. **error 也走 storeAiChatFinalResponseMessages**：`payload.status==='error'` 时存 `_error` 消息 (outbox:419)。推进钩子必须区分 success→推进下一章 vs error→触发退款+整单失败。

4. **wallet_transactions.kind 无 DB CHECK 约束**：`insertWalletTransaction` 接受任意 `kind:string` (billing-repo:1783)，无 migration 即可加 `report_purchase`/`report_refund`。仅文档/类型层登记。

5. **最高 migration id = `0048`** (不是文件名暗示的 0028)。新文件从 `0049` 起。

---

## 1. 数据库设计

### 1.1 新 migration 文件
- 路径：`apps/api/src/infrastructure/migrations/definitions/0049-paid-reports.ts`
- 导出 `export const paidReportMigrations: readonly DatabaseMigration[] = [...]`
- 在 `definitions.ts` 的 `MIGRATIONS` 数组**末尾追加** `...paidReportMigrations`（严禁重排/改写已发布迁移，见 definitions.ts:9 注释）。
- 迁移 id：`0049_report_presets`、`0050_report_orders`（一个文件可含多条；命名延续 `00NN_snake` 规律）。
- 用 `ensureCheckConstraint` (helpers.ts) 加 CHECK，照 simple_workflow_presets 写法 (0020-0028:310)。

### 1.2 `report_presets` 表（报告类型配置，照 simple_workflow_presets 模板）
```
CREATE TABLE IF NOT EXISTS report_presets (
  id TEXT PRIMARY KEY,                          -- 类型 key, e.g. 'bazi-deep-99' / 'iching-quick-9'
  name TEXT NOT NULL,                           -- 后台展示名
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,        -- 锥形定价排序
  summary TEXT NOT NULL DEFAULT '',             -- 商品卖点描述
  paipan_skill TEXT NOT NULL,                   -- 排盘绑定 dir，对齐 paipan-registry 7 种
  paipan_input_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  price_coins NUMERIC(14,2) NOT NULL,           -- 一口价 (coins)，roundCoinsToCents
  model_policy JSONB NOT NULL DEFAULT '{"mode":"system-default"}'::jsonb,
  skill_bundle_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  skill_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  skill_snapshot_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  chapters JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 章节定义数组 (见下)
  free_preview_chapters INTEGER NOT NULL DEFAULT 1, -- 免费试读章数 (钩子=首章)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```
**chapters JSONB 结构**（数组，顺序即生成顺序）：
```jsonc
[
  { "key": "overview",   "title": "命局总览", "prompt_template": "基于盘面，先给整体格局…" },
  { "key": "career",     "title": "事业财运", "prompt_template": "聚焦事业与财…" }
  // …
]
```
- 每章 `key` 唯一、`title` 展示、`prompt_template` 注入 runtimeUserMessageOverride。
- CHECK：`jsonb_typeof(chapters)='array'`、`price_coins > 0`、`free_preview_chapters >= 0`、`paipan_skill IN (...7 dirs)`、`model_policy` mode 合法（照 0020-0028:340）。
- 索引：`idx_report_presets_enabled_sort ON (enabled, sort_order, id)`。
- seed：`INSERT … ON CONFLICT (id) DO NOTHING` 放 1 个 9.9 引流 + 1 个 99 主力（照 simple_workflow_presets seed:368）。

### 1.3 `report_orders` 表（订单，照 recharge_orders + settleRechargeOrderPaid 幂等模板）
```
CREATE TABLE IF NOT EXISTS report_orders (
  id TEXT PRIMARY KEY,                          -- 'rpt-<ts>-<rand>'
  order_no TEXT NOT NULL UNIQUE,                -- 对外单号 (幂等键)，照 recharge trade_id
  user_id TEXT NOT NULL REFERENCES users(id),
  preset_type TEXT NOT NULL,                    -- 下单时的 report_presets.id (软引用，不外键以容忍 preset 改名/删)
  preset_snapshot JSONB NOT NULL,              -- 下单时 preset 快照 (chapters/price/skill 授权)，防配置漂移
  price_coins NUMERIC(14,2) NOT NULL,
  wallet_used_coins NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonus_deducted_coins NUMERIC(14,2) NOT NULL DEFAULT 0,
  purchased_deducted_coins NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',       -- 状态机 (见下)
  session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  chapters_total INTEGER NOT NULL,
  chapters_done INTEGER NOT NULL DEFAULT 0,     -- 已成功落库的章节数 (含免费首章)
  current_user_message_id TEXT,                 -- 当前在途章节的 user message id (幂等/对账)
  failure_reason TEXT,
  refunded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```
**状态机 `status`**（CHECK 约束枚举）：
```
'pending'    -- 已建单未扣费 (一般极短；扣费在同事务，正常不停留)
'generating' -- 已扣费+已建会话+免费首章已发，正在分章生成
'completed'  -- 全部章节成功 (chapters_done == chapters_total)
'failed'     -- 任一章失败，已触发退款流程
'refunded'   -- 退款事务已完成 (与 failed 分离：failed=判定失败, refunded=钱已回)
```
合法转移：`pending→generating→{completed | failed}`、`failed→refunded`。
- 索引：`idx_report_orders_user_created ON (user_id, created_at DESC)`；`idx_report_orders_session ON (session_id)` ← **章节推进钩子靠它反查**；`idx_report_orders_status ON (status, created_at DESC)`（扫卡单/重试）。
- CHECK：`price_coins > 0`、`chapters_total > 0`、`chapters_done >= 0`、`status IN (...)`、`order_no` UNIQUE。

### 1.4 新增 wallet_transaction kind（无 migration）
- `'report_purchase'`：amount = `-price_coins`，balance_source 由 deduction 决定。
- `'report_refund'`：amount = `+wallet_used_coins`，balance_source 照退款明细。
- 在 `inferBalanceSourceFromKind` (billing-repo:312) switch 里**可选**补两条（不补则需显式传 balanceSource，purchase/refund 本就显式传，故非必须）。

---

## 2. 后端 Service 层

### 2.1 新仓储 `apps/api/src/infrastructure/repositories/report-repository.ts`
> presets 读写 + orders 读写。事务函数复用 billing-repo 的 `deductBalanceCoins`/`insertWalletTransaction`（import 跨仓储，已有先例：simple-workflow 调 chat）。在 `db.ts` 末尾 `export { … } from './repositories/report-repository.js'`（照 db.ts:326）。

**Preset 读写（照 simple-workflow-repository）**
```ts
listReportPresets(): Promise<ReportPreset[]>                 // admin 全量
listEnabledReportPresets(): Promise<ReportPreset[]>          // catalog: enabled ORDER BY sort_order
getReportPreset(id): Promise<ReportPreset | undefined>
upsertReportPreset(input): Promise<ReportPreset>            // admin CRUD, ON CONFLICT(id) DO UPDATE
// mapReportPresetRow: chapters/JSONB 归一 (照 mapSimpleWorkflowPresetRow:100)
```

**购买事务（核心，照 subscribeMembershipWithWallet:1138 单事务模板）**
```ts
purchaseReportWithWallet(input: {
  userId: string; presetId: string;
  paipanInput: Record<string, unknown>;      // 已校验过的排盘参数
  skillContextEntry: SkillContextEntryDto;   // service 层先算好盘面再进事务 (排盘不在事务内)
  sessionTitle: string;
}): Promise<{ order: ReportOrderRow; session: ChatSession; boardMessageId: string }>
```
事务步骤（伪代码）：
```
BEGIN
  preset = getReportPreset(presetId) FOR (read);  if !enabled → throw 503
  user   = getUserById(userId, {forUpdate:true})  -- 行锁，防并发扣费
  price  = roundCoinsToCents(preset.price_coins)
  deduction = deductBalanceCoins(client, user, price)   -- 余额不足在此抛 (assertSufficientSpendableCoins)
  order  = INSERT report_orders(status='generating', preset_snapshot=preset,
             price_coins, wallet_used_coins=price,
             bonus/purchased_deducted, chapters_total=preset.chapters.length,
             chapters_done=0, order_no=gen())
  session = createChatSession(...)            -- 复用 createChatSession
  UPDATE report_orders SET session_id=session.id
  storeMessage(board_request) + storeMessage(board_result with tool_context=[skillContextEntry])
     -- metadata: workflow='paid_report', report_order_id, board_skill (照 simple-workflow board msgs:160)
  insertWalletTransaction(kind='report_purchase', amount=-price, balanceSource=deduction.balanceSource,
     requestId=order.order_no, metadata={order_id, preset_type, …})  -- requestId=order_no 保证流水幂等
COMMIT
```
> 排盘 `executeDirectPaipan` 在事务**外**先跑（可能 500ms+，不占 DB 连接/锁）；事务内只做扣费+建单+建会话+落盘面消息。与 simple-workflow 的"先排盘后建会话"一致 (simple-workflow-service.ts:395)。

**退款事务（照 settleRechargeOrderPaid 幂等 + releaseProfessionalAiTurn 反向）**
```ts
refundReportOrder(input: { orderNo: string; reason: string }): Promise<ReportOrderRow>
```
步骤：
```
BEGIN
  order = SELECT … WHERE order_no=$1 FOR UPDATE
  if order.status === 'refunded'  → COMMIT; return order        -- 幂等早返 (照 recharge:2516)
  if order.status !== 'failed'    → 先 UPDATE status='failed', failure_reason=reason
  -- 反向回退：purchased + bonus 各自原路退回
  UPDATE users SET purchased_coins += order.purchased_deducted_coins,
                   bonus_coins      += order.bonus_deducted_coins
      WHERE id = order.user_id
  insertWalletTransaction(kind='report_refund', amount=+order.wallet_used_coins,
       balanceSource=<由退回桶推断 mixed/bonus/purchased>,
       requestId=order.order_no + ':refund', metadata={order_id, reason})
  UPDATE report_orders SET status='refunded', refunded_at=NOW()
COMMIT
```
> ⚠️ 风险：bonus 余额有过期机制 (expireUserBonusBalanceBefore)。原路退 bonus 到 users.bonus_coins 桶即可（与现有 grant 模型一致），不必重建 balance_grants 行——足够 MVP；如需精确可重建一条短期 grant。**标注为权衡点。**

**订单读取**
```ts
getReportOrderById(id) / getReportOrderByNo(orderNo) / getReportOrderBySessionId(sessionId)
listReportOrdersForUser(userId, {limit})
advanceReportOrderChapter(orderNo, {expectChaptersDone}): Promise<...>  -- CAS 推进 (见 §6)
```

### 2.2 报告编排 service `apps/api/src/modules/chat/report-service.ts`
> 公开 3 个入口 + 1 个被 outbox 调用的推进函数。复用 paipan-runtime + chat-session-service。

```ts
// 游客/用户预览：排盘 + 报价 (不扣费、不建会话)
previewReport(input:{ userId?:string; presetId:string; paipanInput }):
   Promise<ServiceResult<ReportPreviewResponseDto>>
   // = previewDirectPaipan 思路 + 返回 preset.price/chapters/free_preview_chapters

// 购买并启动：扣费→建会话→存盘面→生成"免费首章"→返回 session
startReportForOwnedUser(userId, input:{ presetId; paipanInput }):
   Promise<ServiceResult<ReportStartResponseDto>>

// 章节推进 (outbox handler 在每章 success 后调用；error 时调 failReportOrderAndRefund)
maybeAdvanceReportChapter(args:{ sessionId:string; userMessageId:string; status:'success'|'error'; failureReason?:string }):
   Promise<void>
```

**startReportForOwnedUser 流程**
```
preset = getReportPreset(presetId); validate enabled
paipanInput = validateDirectPaipanInput(...) via executeDirectPaipan (skillDir=preset.paipan_skill)
   -- 复用 simple-workflow 的 mapDirectPaipanError
{order, session, boardMessageId} = purchaseReportWithWallet({...})   -- 事务, 见 §2.1
   -- 余额不足 → fail(402, '余额不足，请先充值')  (前端引导易支付充值)
// 立即异步生成"首章 (index 0, 免费钩子)"——与付费章走同一 enqueue 路径，仅 chapter_index 不同
void enqueueReportChapter({ order, session, preset, chapterIndex: 0, boardMessageId })
return ok({ session, boardMessageId, order_no: order.order_no })
```

**enqueueReportChapter（每章一次独立 AI 请求；复用 sendOwnedChatSessionMessage）**
```ts
async function enqueueReportChapter(args:{order, session, preset, chapterIndex, boardMessageId}) {
  chapter = preset.chapters[chapterIndex]
  userMessageId = `rpt-${order.id}-ch${chapterIndex}`   // 确定性 id → 幂等 (重复入队被 409 拦, 见 §6)
  llmRuntime = await resolveSimpleWorkflowLlmRuntime(userId, preset.model_policy)
  llmRuntime = { ...llmRuntime, billingMode: 'none' }   // ★ 关键: 关掉 token 计费, 见 §0.1
  UPDATE report_orders SET current_user_message_id = userMessageId WHERE id = order.id
  result = await sendOwnedChatSessionMessage(userId, session.id, {
     content: `【${chapter.title}】`,                    // 用户端展示用
     inputKind: 'normal',
     selectedBoardMessageId: boardMessageId,             // 让本章读到盘面
  }, {
     userMessageId,
     llmRuntimeOverride: llmRuntime,
     runtimeUserMessageOverride: chapter.prompt_template, // 注入本章 prompt
     authorizedSkillBundleIds: preset.skill_snapshot_ids.length ? undefined : preset.skill_bundle_ids,
     authorizedWorkflowSkillIds: preset.skill_snapshot_ids,
     professionalAiQuotaBypass: 'report_chapter',         // ★ 新增 bypass token, 见下
     sourceMetadata: { /* 仅落在 user msg, 不进 IPC; 见 §0.2 */ },
  })
  if (!result.ok) → failReportOrderAndRefund(order.order_no, result.error)  // 入队失败立即退款
}
```
> **需改 chat-session-service.ts**：`OwnedChatSessionTurnOptions.professionalAiQuotaBypass` 类型从 `'simple_workflow_first_turn'` 扩成 `'simple_workflow_first_turn' | 'report_chapter'`（chat-session-service.ts:130）。第 806 行 `if(!options.professionalAiQuotaBypass)` 逻辑无需改——报告章节同样豁免专家次数占用。

**试读 / 付费边界（核心产品逻辑）**
- 首章 (index 0) 在 `startReportForOwnedUser` 里**已付费后**生成——但它是"免费钩子"的语义来源。
- **决策点**：题述"游客/未付费免费看首章"。两种实现，蓝图推荐 **B**：
  - A（先扣费后试读，简单）：购买即扣全价，首章只是第一条 assistant 消息，"免费试读"指**预览页**用 `previewReport` 展示盘面 + 首章营销文案（静态），真正首章在付费后生成。**MVP 首选，零额外状态机。**
  - B（真免费首章，复杂）：未付费也建一个 `status='generating'` 但 `price 未扣` 的"试读订单"，只生成 index 0；用户点"解锁"再走扣费事务补扣并继续 index 1…。需要订单半付费态 + 二次扣费。**风险高，留作 v2。**
  - ⚠️ **标注**：题述"复用 paipan preview 免费看排盘+首章"更贴近 A——预览页免费展示**排盘结果**（`previewReport` 真算盘面）+ 首章**为营销钩子文案/或截断**；付费后在正式会话里从头生成全部章节。请产品确认 A/B（见文末"待确认"）。

**maybeAdvanceReportChapter（被 outbox 调用，DB 驱动链式推进）**
```
order = getReportOrderBySessionId(sessionId)
if !order || order.status !== 'generating' → return        // 非报告会话/已终态, 直接跳过
if order.current_user_message_id !== userMessageId → return // 不是当前在途章节, 防错配/重复
if status === 'error':
    await failReportOrderAndRefund(order.order_no, failureReason)  // 整单失败+退款
    storeMessage(session, '报告生成失败，费用已全额退回钱包')        // 友好提示
    publishAiChatStreamEvent(refund 提示)
    return
// success: CAS 推进 chapters_done
next = advanceReportOrderChapter(order.order_no, {expectChaptersDone: order.chapters_done})
   // SQL: UPDATE … SET chapters_done = chapters_done + 1
   //      WHERE order_no=$1 AND status='generating' AND chapters_done=$expect RETURNING *
   // 返回 0 行 = 已被并发推进, 直接 return (幂等, 见 §6)
if next.chapters_done >= next.chapters_total:
    UPDATE report_orders SET status='completed', completed_at=NOW()
    storeMessage(session, '报告已全部生成完毕') + stream
else:
    enqueueReportChapter({ order:next, session, preset(from snapshot), chapterIndex: next.chapters_done, boardMessageId })
```
> preset 用 `order.preset_snapshot`（防 admin 中途改 preset 导致章节数/prompt 漂移）。

### 2.3 配置读写 service（admin 用）
- 放 `modules/admin/admin-service.ts`，照 `listSimpleWorkflowPresets`/`updateSimpleWorkflowPreset` (admin-service.ts) 加：
  - `listReportPresetsForAdmin()` → `listReportPresets()`
  - `upsertReportPresetForAdmin(input)` → `upsertReportPreset()`（create+update 合一，ON CONFLICT）
  - `deleteReportPresetForAdmin(id)`（或仅 `enabled=false` 软删，推荐软删，订单 preset_type 软引用）

---

## 3. HTTP 路由

### 3.1 用户态 `apps/api/src/interfaces/http/report-routes.ts`（新文件，照 simple-workflows-routes.ts）
注册：server.ts 增 `await app.register(reportRoutes, { prefix: '/api/reports' })`（server.ts:315 区块）。

| Method | Path | 鉴权 | 请求 DTO | 响应 DTO |
|---|---|---|---|---|
| GET | `/api/reports/catalog` | 公开 | — | `ReportCatalogResponseDto { items: ReportPresetPublicDto[] }` |
| POST | `/api/reports/preview` | 可选 (resolveOptionalUserId, 照 paipan-routes:22) | `ReportPreviewRequestDto { preset_id; input }` | `ReportPreviewResponseDto { skill_context_entry; price_coins; chapters_outline; free_preview_chapters }` |
| POST | `/api/reports/purchase` | `requireAuth()` | `ReportPurchaseRequestDto { preset_id; input }` | `ReportStartResponseDto { session; board_message_id; order_no }` 或 402 `{error}` |
| GET | `/api/reports/orders/:orderNo` | `requireAuth()` (校验 owner) | — | `ReportOrderDto { status; chapters_total; chapters_done; session_id; … }` |
| GET | `/api/reports/orders` | `requireAuth()` | — | `{ orders: ReportOrderDto[] }` |

- purchase 失败映射：余额不足 → 402（前端引导充值）；preset 停用 → 503；排盘参数错 → 400（DirectPaipanError 透传）。
- 进度查询：前端主要靠 chat WebSocket 实时看章节消息；`orders/:orderNo` 用于 header 进度条 "3/6 章" + 失败/退款态兜底（断流时轮询）。

### 3.2 Admin 态（加到现有 admin-routes.ts，前缀 `/api/admin`，自动落 `admin:*` scope）
| Method | Path | scope | 说明 |
|---|---|---|---|
| GET | `/api/admin/reports/presets` | admin:* | 列全部 preset |
| GET | `/api/admin/reports/presets/resources` | admin:* | 可选排盘 dir + skill 资源 (照 `/simple-workflows/resources`) |
| POST | `/api/admin/reports/presets` | admin:* | 创建 (zod schema) |
| PATCH | `/api/admin/reports/presets/:id` | admin:* | 更新 (照 SimpleWorkflowPresetUpdateSchema:271, 加 price_coins/chapters/free_preview_chapters/paipan_skill) |
| DELETE | `/api/admin/reports/presets/:id` | admin:* | 软删 (enabled=false) |
| GET | `/api/admin/reports/orders` | admin:* | 订单列表 (排障/对账, 照 listRechargeOrdersForAdmin) |

- 新 admin 路由**无需**改 `getRequiredAdminScope`/`USER_MANAGER_ALLOWED_ROUTES`——未列入白名单的路由默认要求 `admin:*`（admin-routes.ts:163），owner key 即可，user_manager 自动被拒。
- zod schema 校验 chapters：`z.array(z.object({ key, title, prompt_template }))`，price_coins 用现有 `SoftCurrencyNumberSchema` (admin-routes.ts:186)。

---

## 4. 契约 DTO（`packages/contracts/src/report/index.d.ts` 新建 + 注册 exports）

- contracts/package.json `exports` 加 `"./report": "./src/report/index.d.ts"`。
- 全部 snake_case（对齐现有 DTO 风格）。
- MessageMetadataDto (chat/index.d.ts:7) **扩展**：加 `report_order_id?: string; chapter_index?: number; chapter_key?: string;`（报告章节消息识别用）。

新 DTO 清单：
```ts
ReportPresetPublicDto   { id; name; summary; price_coins; paipan_skill;
                          paipan_input_schema?; chapters_outline: {key;title}[];
                          free_preview_chapters }
ReportPresetAdminDto    extends Public + { enabled; sort_order; model_policy;
                          skill_bundle_ids; skill_ids; skill_snapshot_ids;
                          chapters: {key;title;prompt_template}[]; created_at; updated_at }
ReportChapterDefDto     { key; title; prompt_template }
ReportCatalogResponseDto{ items: ReportPresetPublicDto[] }
ReportPreviewRequestDto { preset_id; input: Record<string,unknown> }
ReportPreviewResponseDto{ skill_context_entry: SkillContextEntryDto; price_coins;
                          chapters_outline: {key;title}[]; free_preview_chapters }
ReportPurchaseRequestDto{ preset_id; input: Record<string,unknown> }
ReportStartResponseDto  { session: ChatSessionDto; board_message_id; order_no }
ReportOrderStatusDto    = 'pending'|'generating'|'completed'|'failed'|'refunded'
ReportOrderDto          { id; order_no; preset_type; price_coins; status;
                          session_id; chapters_total; chapters_done;
                          failure_reason?; refunded_at?; completed_at?; created_at }
// admin 写入
ReportPresetUpsertRequestDto { id?; name; enabled; sort_order; summary; paipan_skill;
                          paipan_input_defaults; price_coins; model_policy;
                          skill_bundle_ids; skill_ids; chapters; free_preview_chapters }
```

---

## 5. 前端（apps/web）

### 5.1 复用 chat-session 展示报告（零新渲染器）
- 报告会话就是普通 chat session：购买成功拿到 `session` → 复用 `ai-chat-workspace.tsx` 的 `setSelectedSession(session.id)`（照 handleSimpleWorkflowStarted:605）→ `use-chat-messages.ts` WebSocket 流自动渲染每章 assistant 消息。
- 章节消息靠 `metadata.workflow==='paid_report'` + `chapter_index` 识别，可在 message-footer/标题加"第 N 章"徽标（复用 `components/chat/message-footer.tsx`）。

### 5.2 新增清单
**feature 层** `apps/web/features/reports/`
```
api.ts                      reportsApi: { catalog, preview, purchase, getOrder, listOrders }
                            (照 features/simple-workflows/api.ts + features/paipan/api.ts)
hooks/use-report-catalog.ts 列报告商品
hooks/use-report-order.ts   轮询 orders/:orderNo 作为流断兜底 (进度条/退款态)
```
**页面/组件**
```
app/reports/page.tsx                     报告商品列表入口页 (catalog → 卡片网格, 锥形定价 9.9/99)
components/reports/report-catalog.tsx     商品卡片 + 卖点
components/reports/report-purchase-flow.tsx
    1) 选报告类型 → 2) 填排盘参数 (复用 components/ai-chat/paipan-flows/*, 按 preset.paipan_skill 选 flow)
    3) preview() 展示盘面 + 章节大纲 + 价格 + "首章免费试读"
    4) purchase():
        - 200 → 跳 /ai-chat?session=<id> 看分章生成 (或内嵌 ai-chat-workspace)
        - 402 余额不足 → 弹窗引导 /wallet 充值 (复用 features/billing recharge: createRechargeOrder → epay)
components/reports/report-progress-banner.tsx  会话顶部 "生成中 3/6 章 / 已完成 / 已退款"
```
**"首章试读 + 付费解锁" UI 状态**（对应 §2.2 方案 A）
- 预览态：preview 返回盘面 (真实) + 章节大纲 (只标题) + 首章营销文案/截断 + 价格 + CTA「{price} 解锁完整 N 章报告」。
- 付费后：跳会话，首章起逐条 streaming 出现；进度 banner 显示 `chapters_done/total`。
- 失败：banner 转红「生成失败，已全额退款」，复用 order.status==='refunded'。
- 余额不足：purchase 返回 402 → 充值引导浮层（带回跳，充值成功回到 purchase）。

**i18n**：照现有 `t('aiChat.simpleMode.*')` 加 `t('reports.*')`。

---

## 6. 章节编排：并发 & 幂等 & 状态安全

| 风险 | 机制 (全部复用现有 + DB 约束) |
|---|---|
| **重复扣费** | 购买事务内 `getUserById(forUpdate:true)` 行锁 + `deductBalanceCoins` 余额校验；`wallet_transactions.request_id = order_no` 提供流水幂等键。前端 purchase 防抖 + 后端建单前可加"同 user 近 N 秒 generating 单"软拦（可选）。 |
| **重复触发章节** | 章节 userMessageId 确定性 = `rpt-<orderId>-ch<idx>`；`prepareOwnedChatSessionTurn` 检测同 id 已存在 → `fail(409,'消息已处理')` (chat-session-service.ts:818)。重复 enqueue 自动被拦。 |
| **章节推进竞态** | `advanceReportOrderChapter` 用 **CAS**：`UPDATE … WHERE status='generating' AND chapters_done=$expect RETURNING *`。返回 0 行=已被推进 → 直接 return。杜绝同章 outbox 重放导致跳章/多扣。 |
| **会话级串行** | 现有 `session:processing` Redis 锁 (claimChatSessionProcessing:185)：同一 session 同时只 1 个在途 turn。前章 response 在 `releaseCompletedAiChatSessionLock` 释放锁后，推进钩子才 enqueue 下一章 → 天然串行，不会两章并发。 |
| **订单终态幂等** | refund 事务 `status==='refunded'` 早返 (照 settleRechargeOrderPaid:2516)；complete/fail 转移都带 `WHERE status='generating'` 守卫。 |
| **崩溃/漏触发** | `idx_report_orders_status` 支持扫 `status='generating' 且 updated_at 过期` 的卡单：可加一个轻量 reconcile（照 reconcileStaleBillingReservations）作为 v1.1 兜底，MVP 可手动。 |
| **error 双路径** | outbox `processAiChatResponse` 的 error 分支 (catch) 与 success 分支都要调 `maybeAdvanceReportChapter`（success/error 入参不同）。在 `storeAiChatFinalResponseMessages` 之后、函数返回前统一调用一次，内部按 `payload.status` 分流。 |

**outbox 接入点（唯一改动 ipc-ai-chat-outbox-handler.ts）**
- 在 `processAiChatResponse` 成功路径：`releaseCompletedAiChatSessionLock` 之后、`publishAiChatStreamEvent` 之后，追加：
  ```ts
  await maybeAdvanceReportChapter({
    sessionId, userMessageId: resolveAiChatFinalUserMessageId(pending, payload),
    status: payload.status === 'error' ? 'error' : 'success',
    failureReason: payload.error,
  }).catch(err => logger.error({err}, 'report chapter advance failed'));
  ```
- error 路径（catch 块）也需调用一次（status='error'）。用 try/catch 包裹，**绝不**让推进失败阻断 outbox 主流程。
- ⚠️ **解耦建议**：outbox handler 不直接 import report-service（避免 runtime↔modules/chat 循环依赖）。采用**回调注册**：report-service 在启动时 `registerReportChapterAdvancer(fn)`，outbox 调已注册的 advancer（照现有 stream/lease 的注入风格）。或将 `maybeAdvanceReportChapter` 放在 runtime 层薄封装。**标注为接线细节，实现时验证依赖方向。**

---

## 7. 实施顺序（每阶段可独立验证）

**阶段 1 — DB + 配置 (无行为)**
- 写 `0049-paid-reports.ts`（report_presets + report_orders），注册进 MIGRATIONS。
- report-repository.ts: preset CRUD + order 读取 + map 函数。
- contracts/report DTO + exports。
- 验证：`pnpm --filter @fateclaw/api typecheck`；起 API 跑 migration（看 migrations 应用日志）；psql 确认建表 + seed。

**阶段 2 — 购买扣费 (不生成 AI)**
- `purchaseReportWithWallet` 事务 + `report_purchase` 流水。
- report-routes purchase（先不 enqueue 章节，仅扣费+建会话+落盘面）。
- 验证：vitest 写购买事务单测（足额扣费成功 / 余额不足 402 / 流水正确）；手动 POST purchase 看 report_orders + wallet_transactions + chat_sessions 落库。参考现有 billing 测试。

**阶段 3 — 单章生成 (首章)**
- `enqueueReportChapter`（billingMode:'none' override + report_chapter bypass）。
- 扩 `OwnedChatSessionTurnOptions.professionalAiQuotaBypass` 类型。
- startReportForOwnedUser 接 enqueue index 0。
- 验证：手动 purchase → 看会话出现 1 条 board + 首章 assistant 消息流式生成；确认 **wallet 无 token 二次扣费**（对比 wallet_transactions 只有 1 条 report_purchase）。

**阶段 4 — 多章链式编排**
- `maybeAdvanceReportChapter` + `advanceReportOrderChapter` CAS。
- outbox handler 接入点（回调注册）。
- 验证：purchase 一个 2-3 章 preset → 看章节**顺序**逐条出现，chapters_done 递增，末章后 status='completed'。并发测试：人工重放一条 outbox response 看 CAS 拦截（chapters_done 不跳）。

**阶段 5 — 失败退款**
- `refundReportOrder` 事务 + `failReportOrderAndRefund`。
- outbox error 分支接 advance(status='error')。
- 验证：构造一章必失败（如临时改 prompt 触发模型 error 或 mock）→ 看 status='failed'→'refunded'，wallet 出现 `report_refund` 正流水，余额回到购买前；会话出现"已退款"提示。幂等：重复调 refund 不重复退。

**阶段 6 — 前端**
- features/reports api+hooks；app/reports 商品页；purchase-flow（复用 paipan-flows + ai-chat-workspace）；进度 banner；402 充值引导。
- 验证：`pnpm --filter fateclaw-web exec tsc --noEmit`；端到端点一单 9.9 报告走完试读→购买→分章生成→完成；点一单触发余额不足→充值引导。

**阶段 7 — Admin**
- admin-service report preset CRUD + admin-routes 路由 + zod schema。
- admin 前端（apps/admin features/components，照现有 simple-workflows admin 页）。
- 验证：`pnpm --filter fateclaw-admin exec tsc --noEmit`；admin 建/改/停用 preset，前台 catalog 实时反映；改 chapters 后**已下单**订单用 snapshot 不受影响。

**全程**：每阶段跑 `pnpm typecheck`（根脚本含 4 包）；提交前 `pnpm test` + `pnpm lint`。

---

## 8. 待产品确认
1. **试读策略 A vs B**（§2.2）：A=预览页免费展示真实盘面+首章营销文案，付费后正式会话从头生成全部章节（MVP 推荐，零半付费态）；B=真生成免费首章再二次扣费解锁后续（v2）。蓝图按 A 设计，B 需加订单半付费态 + 二次扣费事务。
2. **bonus 退款精度**（§2.1）：退到 bonus_coins 桶 vs 重建带过期的 balance_grant。MVP 退桶。
3. **章节 token 成本归集**：确认报告一口价已覆盖 N 章 token 成本（billingMode:'none' 表示平台吸收，不再向用户计 token 费）。

---

## 实现关键文件锚点
- 购买事务模板：billing-repository.ts:1138 `subscribeMembershipWithWallet`
- 扣费原子：billing-repository.ts:3020 `deductBalanceCoins`
- 幂等订单状态机：billing-repository.ts:2492 `settleRechargeOrderPaid`
- 反向退款：billing-repository.ts:1603 `releaseProfessionalAiTurn`
- 两阶段异步生成：modules/chat/simple-workflow-service.ts:369 `startSimpleWorkflowForOwnedUser`
- 单章 turn override 入口：modules/chat/chat-session-service.ts:734/118 `sendOwnedChatSessionMessage` + `OwnedChatSessionTurnOptions`
- 章节链式接入点：runtime/ipc-ai-chat-outbox-handler.ts:549 `processAiChatResponse`
- billingMode 短路：modules/billing/plans.ts:129/175；runtime 解析 modules/system/system-config.ts:711
- 排盘复用：modules/chat/paipan-runtime.ts:329 `executeDirectPaipan`
- preset 表/DB 模板：migrations 0020-0028:290 + repositories/simple-workflow-repository.ts
- 路由/鉴权模板：interfaces/http/simple-workflows-routes.ts、paipan-routes.ts:22、admin-routes.ts:146/931
