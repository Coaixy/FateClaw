# 会员等级完整迁移方案

> ⚠️ **本文已过时（历史方案，勿据此判断现状）。** 文中的 Free / Clarity / Insight / Deep
> 四档权限矩阵是一个中间阶段的设计，**之后又被"单层化"重构整体取代**：迁移 `0058` 已把所有
> 历史档位归一为单一的 `clarity`，系统现在只有"有/无有效会员"二元判断，AI 解读对非会员一律
> 拦截（不再有 Free 简易模式免费路径）。当前事实请以
> [`membership-entitlement-current.md`](../membership-entitlement-current.md) 为准。本文仅作历史归档。

最近核对：2026-06-15。

这份文档记录 Free、Clarity、Insight、Deep 四档权限重划分的完整迁移方案。目标是把现在混在一起的“会员”判断拆成明确的能力判断，避免新增 Clarity 后误拿到 Insight/Deep 权限。

## 目标权限矩阵

| 能力                | Free   | Clarity  | Insight  | Deep     |
| ------------------- | ------ | -------- | -------- | -------- |
| 简易模式            | 可用   | 可用     | 可用     | 可用     |
| 手动排盘            | 可用   | 可用     | 可用     | 可用     |
| 专家模式 / 专家追问 | 不可用 | 可用     | 可用     | 可用     |
| 专家 AI 每日次数    | 0      | 10       | 30       | 100      |
| 会员 allowance      | 无     | 后台配置 | 后台配置 | 后台配置 |
| 自定义模型          | 不可用 | 不可用   | 可用     | 可用     |
| runtime 优先队列    | normal | normal   | member   | member   |
| 微信 Claw           | 不可用 | 不可用   | 不可用   | 可用     |

注意：Free 没有会员 allowance。专家 AI 每日次数也不是会员 allowance，它应该是一套独立的每日次数规则。

## 当前现状

当前系统只有两个底层套餐 key：

- `fateclaw_plus`：前端展示为 Insight。
- `fateclaw_pro`：前端展示为 Deep。

主要入口：

- 后端会员常量和 rank：`apps/api/src/shared/membership-plans.ts`
- 前端会员常量和展示名：`apps/web/features/billing/membership-plans.ts`
- 会员配置、购买、发放、allowance、Free 专家次数：`apps/api/src/infrastructure/repositories/billing-repository.ts`
- 专家 AI 门禁：`apps/api/src/modules/chat/chat-session-service.ts`
- 自定义模型门禁：`apps/api/src/modules/system/system-config.ts`
- 微信 Claw 绑定和消息门禁：`apps/api/src/modules/account/account-http-service.ts`、`apps/api/src/modules/chat/message-handler.ts`
- runtime 优先队列：`apps/api/src/runtime/ipc-worker.ts`、`apps/agent-runtime/src/daemon.ts`
- 管理后台奖励/会员配置：`apps/admin/app/(dashboard)/system/reward-config-panel.tsx`
- 前台会员页：`apps/web/components/settings/membership/membership-workspace.tsx`

现在最大的风险点是 `hasBaseMembershipEntitlement()` 被多处复用。它同时控制：

- 是否是付费会员。
- 专家模式是否绕过 Free quota。
- 微信 Claw 是否可绑定和处理消息。
- runtime 是否进 member 优先队列。
- 自定义模型是否可用。
- 前端设备页、顶栏会员态等 UI。

新增 Clarity 后不能继续用一个 helper 表达所有能力，否则 Clarity 会被错误地放进微信 Claw、自定义模型或优先队列。

## 新套餐 key

建议做完整 re-key，不继续让 `fateclaw_plus` 代表 Insight、`fateclaw_pro` 代表 Deep。

新 key：

- `fateclaw_clarity`
- `fateclaw_insight`
- `fateclaw_deep`

迁移期兼容映射：

- `fateclaw_plus` -> `fateclaw_insight`
- `fateclaw_pro` -> `fateclaw_deep`
- `default` membership config -> `fateclaw_insight`

迁移完成后，业务代码只应该输出新 key。旧 key 只作为输入兼容和历史数据兜底。

## 数据库迁移

新增迁移建议命名为 `0042_membership_tier_rekey`，追加到现有 migration 分段末尾。现有最后一条是 `0041_oauth_user_identities`。

### 1. 迁移 membership_config

目标配置行：

| id                 | name             | monthly_price_coins   | display_price_coins   |
| ------------------ | ---------------- | --------------------- | --------------------- |
| `fateclaw_clarity` | FateClaw Clarity | 10                    | 10                    |
| `fateclaw_insight` | FateClaw Insight | 沿用原 `default`      | 沿用原 `default`      |
| `fateclaw_deep`    | FateClaw Deep    | 沿用原 `fateclaw_pro` | 沿用原 `fateclaw_pro` |

建议：

- 先 conflict-safe 插入新三行，来源分别复制旧 `default`、旧 `fateclaw_pro`。
- 再把 `user_memberships` 和 `membership_allowances` 的旧 key 改成新 key。
- 最后将旧 `default`、`fateclaw_pro` 配置行标记为 legacy 或删除。为了回滚风险更低，第一版可以保留但业务代码不再读取。

如果 Clarity 需要没有会员 allowance，当前 `membership_config.monthly_allowance_units > 0` 的 check constraint 要改成 `>= 0`。如果产品希望 Clarity 也有后台配置的少量 allowance，则可以保留正数约束。

### 2. 迁移用户会员和 allowance

需要更新：

- `user_memberships.plan_key`
- `membership_allowances.plan_key`
- 钱包交易 `wallet_transactions.metadata.planKey` 中的历史 key

迁移规则：

- `fateclaw_plus` 改为 `fateclaw_insight`
- `fateclaw_pro` 改为 `fateclaw_deep`

由于 `user_memberships` 主键是 `(user_id, plan_key)`，迁移前要先检查是否已经存在新旧 key 共存的脏数据。若存在，需要按更晚的 `current_period_end` 和更高档 rank 合并，再改 key。

### 3. 替换 Free 专家次数表

现有表是 Free 专用：

- `ai_chat_free_quota_config`
- `ai_chat_free_daily_usage`

新规则是所有用户共享“专家 AI 每日次数”计数，不再是 Free quota。建议新增：

```sql
CREATE TABLE IF NOT EXISTS ai_chat_professional_daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  professional_turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, usage_date)
);
```

迁移时把 `ai_chat_free_daily_usage` 的当天/历史计数复制到新表，避免同一天用户先用旧 Free 次数、再升级后次数被清零。

专家每日上限固定走代码策略：

- Free: 0
- Clarity: 10
- Insight: 30
- Deep: 100

`ai_chat_free_quota_config` 不再出现在后台配置中。为了发布更稳，第一版可以停用但不 drop；确认线上无回滚需求后再做 cleanup migration 删除旧表。

## 后端代码迁移

### 1. 拆分 entitlement helper

在 `apps/api/src/shared/membership-plans.ts` 中新增明确能力 helper：

- `hasPaidMembershipEntitlement()`：Clarity 及以上。
- `hasExpertModeEntitlement()`：Clarity 及以上。
- `hasPriorityQueueEntitlement()`：Insight 及以上。
- `hasCustomModelEntitlement()`：Insight 及以上。
- `hasWechatClawEntitlement()`：Deep 及以上。
- `resolveProfessionalAiDailyTurnLimit()`：返回 0、10、30、100。

`hasBaseMembershipEntitlement()` 可以保留为兼容 wrapper，但新代码不要再用它做具体能力判断。

### 2. 购买和后台发放

需要更新：

- `apps/api/src/interfaces/http/billing-routes.ts`
- `apps/api/src/interfaces/http/admin-routes.ts`
- `apps/api/src/infrastructure/repositories/billing-repository.ts`
- `apps/api/src/modules/admin/admin-service.ts`

购买接口、后台用户发放、后台奖励配置的 `plan_key` enum 都要接受三档新 key。默认购买 fallback 建议改成 Clarity，因为它是新的最低付费档。

`getMembershipConfigUsing()` 不再把 Insight 映射到 `default`，而是按新 key 直接读取对应 `membership_config.id`。

### 3. 专家 AI 每日次数

`apps/api/src/modules/chat/chat-session-service.ts` 当前逻辑是：

- 非会员才调用 `claimFreeProfessionalAiTurn()`
- 会员无限专家次数

迁移后应改为：

1. 简易模式首轮 `plusGateBypass: 'simple_workflow_first_turn'` 继续不扣专家次数。
2. 其他专家模式或追问统一读取当前会员 rank。
3. 按 `resolveProfessionalAiDailyTurnLimit()` 得到上限。
4. 上限为 0 直接返回升级 Clarity 的错误。
5. 上限大于 0 时调用新的 `claimProfessionalAiTurn()`。
6. 入队失败、抢占失败、运行失败时继续调用 `releaseProfessionalAiTurn()` 退回次数。

错误文案要从 “开通 FateClaw Plus” 改为 “开通 FateClaw Clarity 或更高等级”。

### 4. 自定义模型

`apps/api/src/modules/system/system-config.ts` 里当前用 `hasBaseMembershipEntitlement()` 判断自定义模型。迁移后改用 `hasCustomModelEntitlement()`。

前端 `apps/web/components/settings/model-settings-panel.tsx` 的锁定文案改成 Insight 及以上。

### 5. 微信 Claw

微信 Claw 应只给 Deep：

- `apps/api/src/modules/account/account-http-service.ts`
- `apps/api/src/modules/chat/message-handler.ts`
- `apps/api/src/app/index.ts`
- `apps/web/components/workspace/devices-panel.tsx`

这些位置要从 “会员” 判断改成 `hasWechatClawEntitlement()`。绑定和消息拒绝文案也要从 Plus 改成 Deep。

### 6. runtime 优先队列

现有 runtime 已经有优先队列，不需要新造队列：

- 宿主侧 `resolveInboxPriority()` 返回 `member` 或 `normal`。
- 全局并发等待队列有 `agent:concurrency:wait:member` 和 `agent:concurrency:wait:normal`。
- 槽位释放时优先唤醒 member 队列。
- 入 runtime 队列时会写 `ipc:{runtimeId}:inbox:member` 或 `ipc:{runtimeId}:inbox`。
- agent-runtime `BRPOP` 顺序是 `inbox:member` 在前，普通 `inbox` 在后。

迁移只需要把 `resolveInboxPriority()` 的判断从 `hasBaseMembershipEntitlement()` 改成 `hasPriorityQueueEntitlement()`。这样 Insight/Deep 进 member 队列，Free/Clarity 仍进 normal 队列。

## 前端和后台迁移

### Web 前台

需要更新：

- `apps/web/features/billing/membership-plans.ts`
- `apps/web/components/settings/membership/membership-workspace.tsx`
- `apps/web/components/ai-chat/ai-chat-workspace.tsx`
- `apps/web/components/settings/model-settings-panel.tsx`
- `apps/web/components/workspace/devices-panel.tsx`
- `apps/web/components/settings/wallet/wallet-membership-card.tsx`
- `apps/web/lib/i18n/messages/en.ts`
- `apps/web/lib/i18n/messages/zh-cn.ts`
- `apps/web/lib/i18n/messages/zh-tw.ts`

会员页要展示三张付费卡：Clarity、Insight、Deep。Free 区域不能出现“配额”表达，只保留简易模式、手动排盘和升级入口。

AI Chat 首页建议前置专家模式锁：

- Free 点击专家模式时，引导升级 Clarity。
- Clarity/Insight/Deep 可进入专家模式。
- 专家次数用完时展示对应日限错误。
- 简易模式入口始终保留。

排盘后类似“你可以直接提问”的文案要按权限调整，避免 Free 用户看到可追问暗示。

### Admin 后台

需要更新：

- `apps/admin/lib/admin-api.ts`
- `apps/admin/app/(dashboard)/system/reward-config-panel.tsx`
- `apps/admin/app/(dashboard)/users/page.tsx`
- `apps/admin/app/(dashboard)/overview/page.tsx`

后台奖励配置页移除 “Free 专业模式 AI” 配置块，会员配置列表改成 Clarity、Insight、Deep 三档。用户详情页的会员下拉和展示名也改成新 key。

## 测试计划

后端测试：

- `apps/api/tests/shared/membership-plans.test.ts`
  - 新 key normalize、rank、legacy key 映射。
  - 各 entitlement helper 覆盖 Free/Clarity/Insight/Deep。
- `apps/api/tests/infrastructure/repositories/billing-repository.test.ts`
  - 三档 config 默认补齐。
  - 旧 key 数据迁移后的 active membership 排序。
  - `claimProfessionalAiTurn()` 日限和退回。
- `apps/api/tests/modules/chat/chat-session-service.test.ts`
  - Free 专家模式直接拒绝。
  - Clarity 每日 10 次。
  - Insight 每日 30 次。
  - Deep 每日 100 次。
  - 简易模式首轮 bypass 不扣次数。
  - 入队失败后退回次数。
- `apps/api/tests/modules/admin/admin-service.test.ts`
  - 后台 reward config 返回三档。
  - 后台用户可发放三档。
- 自定义模型相关测试
  - Clarity 不可保存/选择自定义模型。
  - Insight/Deep 可用。
- 微信 Claw 测试
  - Insight 不能绑定或处理微信消息。
  - Deep 可以绑定和处理微信消息。

前端测试：

- `apps/web/tests/features/billing/membership-plans.test.ts`
  - 三档展示名、rank、legacy key 映射。
- 会员页组件测试或 Playwright 截图
  - 三张卡片展示正常。
  - Free 区域无 allowance 文案。
  - 移动端不再出现截图中的布局挤压。

## 发布顺序

建议按两步发布，降低线上风险：

1. 先发兼容代码和迁移：
   - 新代码能读新 key，也能兼容旧 key。
   - migration 把旧数据改成新 key。
   - 专家每日次数改用新表。
   - 后台不再暴露 Free 专家次数配置。
2. 观察一版后清理 legacy：
   - 删除或停用 `ai_chat_free_*` 旧表。
   - 删除旧 `default`、`fateclaw_pro` 配置行，或保留为只读历史。
   - 收紧日志和监控，只接受新 key 输出。

## 验收标准

- 数据库中 active 用户会员只出现 `fateclaw_clarity`、`fateclaw_insight`、`fateclaw_deep`。
- Free 用户可以简易模式和排盘，但专家模式/追问被拦截。
- Clarity 可专家模式，达到每日 10 次后被拦截。
- Insight 可专家模式，达到每日 30 次后被拦截，并进入 runtime member 优先队列。
- Deep 可专家模式，达到每日 100 次后被拦截，可使用微信 Claw，并进入 runtime member 优先队列。
- Clarity 无法使用自定义模型，Insight/Deep 可以。
- 前台会员页、后台会员配置、后台用户发放全部显示 Clarity/Insight/Deep。
