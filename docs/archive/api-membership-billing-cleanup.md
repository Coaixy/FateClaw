# API 会员与余额领域清理修改文档

> ⚠️ **部分过时。** 文中**会员档位相关内容已废弃**：四档 key（plus/pro/insight/deep）、
> Free 专家每日次数、会员 allowance、按档位推导优先队列/自配模型等，均已被"单层化"重构取代
> （迁移 `0058` 全量归一为 `clarity`，会员不再含 AI 免费额度）。**钱包四字段、`available_coins`
> 公式、metered 预留→结算计费命名等领域规范仍然有效。** 会员/AI 解读门禁的当前事实请以
> [`membership-entitlement-current.md`](../membership-entitlement-current.md) 为准。

最近核对：2026-06-17。

本文描述 `apps/api` 和 `apps/api/src/runtime` 中会员、余额、配额和 runtime 权限判断的统一清理方案。本文按领域归类，不表达实施优先级。目标是让同一个业务概念在数据库、repository、service、HTTP contract 和 runtime 中只有一种主语义，历史字段只停留在兼容边界内。

## AI 执行约束

执行本文时按“收敛同一概念的所有调用点”提交改动，不按单个文件零散修补。每个旧字段或旧函数被替换时，必须同步更新调用方、测试、contract 类型和文档引用。

所有新增或修改的代码注释使用中文。已有英文注释不主动翻译。不要删除历史 migration 文件，不要重写无关模块，不要顺手调整 UI 样式。

执行完成后，仓库内不应再出现新的业务写入路径使用旧套餐 key、旧 Free 专家次数函数、旧 `available_coins` 公式或旧泛化会员判断。历史 migration、兼容测试和显式标注 deprecated 的兼容分支可以保留旧符号。

## 目标状态

后端把会员相关概念拆成四类，并在所有调用点按这四类命名：

| 概念 | 统一命名 | 说明 |
| --- | --- | --- |
| 会员身份 | `membership` | 用户是否拥有有效会员权益。`status = active` 只是状态字段，必须同时满足有效期未过。 |
| 会员套餐 | `plan_key` | 当前只允许 `fateclaw_clarity`、`fateclaw_insight`、`fateclaw_deep` 三个业务 key。 |
| 会员模型额度 | `allowance_*` | 用于抵扣模型用量费用的周期额度，不是钱包余额，也不是每日次数。 |
| 每日专家次数 | `professional_*_turn_limit` / `professional_daily_usage` | 专家 AI 次数限制，独立于会员模型额度和钱包余额。 |
| 钱包余额 | `*_coins` | 充值、赠送、冻结、可消费余额统一以软妹币 `coins` 表达。 |

任何新代码不得再引入 `vip`、`credits`、`points`、`cents`、`yuan`、`tier_key` 表达会员或余额业务。历史数据迁移和兼容读取中可以识别这些旧名，但不能向新的 API 响应、service 类型或 runtime payload 扩散。

## 字段规范

### 会员套餐

`apps/api/src/shared/membership-plans.ts` 是套餐 key 和权限矩阵的唯一来源。

保留的新 key：

- `fateclaw_clarity`
- `fateclaw_insight`
- `fateclaw_deep`

只读兼容的旧 key：

- `fateclaw_plus` 映射为 `fateclaw_insight`
- `fateclaw_pro` 映射为 `fateclaw_deep`
- `membership_config.id = default` 映射为 `fateclaw_insight`

HTTP 写入入口不再接受旧 key。旧 key 只允许出现在 migration、历史 DB 读取、历史 wallet metadata 解释和数据修复脚本中。

### 会员有效性

`user_memberships.status` 只表达记录状态，不直接等价于当前有效会员。业务有效性统一定义为：

```ts
membership.status === 'active' &&
new Date(membership.current_period_end).getTime() > now.getTime()
```

对外 DTO 中的 `membership.active` 表达“当前有效”，不是 DB 原始 `status` 的直接透出。任何需要判断权益的地方都不得直接读取 `status`，必须使用统一的会员权益快照。

### 会员周期和额度周期

会员权益期使用 `current_period_start` / `current_period_end`。这是用户拥有某个套餐权益的时间范围。

会员额度周期使用 `membership_allowances.period_start` / `membership_allowances.period_end`，对外命名为 `allowance_period_start` / `allowance_period_end` 或继续只暴露 `allowance_reset_at`。它不是购买周期，不能和会员权益期混用。

`resolveMembershipAllowancePeriod()` 继续作为兼容历史提前续费记录的唯一周期计算函数。新逻辑不得自行用 `current_period_start` 推导额度周期。

### 钱包余额

钱包余额统一保留以下字段：

- `purchased_coins`：充值余额，不过期。
- `bonus_coins`：赠送余额，可按批次过期。
- `reserved_coins`：冻结余额，保留历史兼容。
- `available_coins`：可消费余额。

`available_coins` 的统一定义为：

```ts
Math.max(0, purchased_coins + bonus_coins - reserved_coins)
```

如前端或后台需要展示未扣冻结的总额，应新增 `total_balance_coins = purchased_coins + bonus_coins`，不能继续让 `available_coins` 在不同接口里表达不同公式。

所有余额响应必须同时返回 `purchased_coins`、`bonus_coins`、`reserved_coins`、`available_coins`。管理端发放赠送余额、调整充值余额、礼品码兑换、签到奖励、充值到账等响应保持同一结构。

### 模型计费和会员 allowance

会员 allowance 是模型费用抵扣额度。它不是钱包余额，也不是 token budget。相关字段保持：

- `monthly_allowance_units`
- `allowance_units`
- `used_units`
- `membership_covered_coins`
- `membership_consumed_units`

`membership_consumed_units` 表示按 `standard_price_per_million_units_coins` 换算后的额度单位，不能在 UI 或日志中描述成余额扣款。

模型上下文预算继续使用 `token_budget`、`context_window_tokens`、`max_output_tokens`，不得和会员 `allowance_units` 混用。

### 每日专家次数

每日专家次数统一使用 `ai_chat_professional_daily_usage`。旧的 `ai_chat_free_daily_usage` 和 `claimFreeProfessionalAiTurn()` 属于兼容代码，不再被新路径调用。

每日次数规则由会员套餐解析：

| plan | daily turn limit |
| --- | --- |
| Free | 0 |
| Clarity | 10 |
| Insight | 30 |
| Deep | 100 |

后台仍可展示历史 `free_professional_ai.daily_turn_limit` 的兼容配置时，文案必须说明它是旧配置，不再作为新会员体系的主规则。

## 统一权益快照

runtime、聊天、模型设置和微信 Claw 不再分别读取 `getMembershipOverview()` 后自行判断能力。新增统一的权益快照服务，例如：

```ts
export interface RuntimeEntitlementSnapshot {
  userId: string;
  membershipActive: boolean;
  planKey: MembershipPlanKey | null;
  planRank: number;
  hasPaidMembership: boolean;
  hasPriorityQueue: boolean;
  canUseCustomModel: boolean;
  canUseWechatClaw: boolean;
  professionalAiDailyTurnLimit: number;
  wallet: {
    purchasedCoins: number;
    bonusCoins: number;
    reservedCoins: number;
    availableCoins: number;
    inArrears: boolean;
  };
}
```

权益快照由会员概览、钱包余额和套餐规则统一生成。调用方只能消费布尔能力，不允许重新解释 `plan_key`。

使用该快照的模块：

- `apps/api/src/runtime/ipc-worker.ts`
- `apps/api/src/modules/chat/chat-session-service.ts`
- `apps/api/src/modules/chat/message-handler.ts`
- `apps/api/src/modules/account/account-http-service.ts`
- `apps/api/src/modules/system/system-config.ts`
- `apps/api/src/modules/billing/plans.ts`

结算函数可以在事务内重读会员和余额以保证一致性，但 runtime 请求 metadata 应记录当时的 `planKey`、`membershipActive` 和 `availableCoins`，便于审计实际按哪个权益处理。

## 模块改动

### `apps/api/src/shared`

`membership-plans.ts` 只保留套餐、rank 和能力矩阵。新代码使用能力函数，不使用旧的泛化会员函数：

- `hasPaidMembershipEntitlement()`
- `hasExpertModeEntitlement()`
- `hasPriorityQueueEntitlement()`
- `hasCustomModelEntitlement()`
- `hasWechatClawEntitlement()`
- `resolveProfessionalAiDailyTurnLimit()`

`hasBaseMembershipEntitlement()` 保留为兼容 wrapper，但新代码不再调用。

`balance-coins.ts` 是余额可消费公式的唯一来源。`getWalletBalanceSummary()`、admin stats、auth contract、billing contract 都必须复用同一公式。

### `apps/api/src/infrastructure/repositories`

`billing-repository.ts` 中旧套餐排序和旧 key normalize 保留在读取兼容路径中。写入路径只接受三档新 key。

`claimFreeProfessionalAiTurn()`、`releaseFreeProfessionalAiTurn()` 和 `FreeProfessionalAi*` 类型标为兼容代码，并从 `infrastructure/db.ts` 的主业务导出中移除。测试迁移到 `claimProfessionalAiTurn()`。

`referrals-repository.ts` 中邀请奖励继续使用 `reward_membership_plan_key`，但只允许新 key。邀请奖励发放的是会员天数，不是钱包奖励，文档和注释统一称为“邀请会员天数奖励”。

### `apps/api/src/modules/billing`

`plans.ts` 保留内部 camelCase summary，但不直接负责 contract snake_case 映射。`availableCoins` 使用统一可消费余额公式。

`billing-service.ts` 不再手写会员和钱包 DTO 拼装，改调用 `contracts-adapter/billing-contract.ts` 中的映射函数。

`estimated_monthly_total_coins` 改为兼容字段。新增或内部统一使用 `monthly_charged_coins` 表示已经实际结算的当月模型费用。

### `apps/api/src/contracts-adapter`

`billing-contract.ts` 从 passthrough 改为真实边界层，集中处理：

- 内部 camelCase 到 contract snake_case。
- `monthly_charged_coins` 和 `estimated_monthly_total_coins` 的兼容输出。
- 钱包余额四字段统一输出。
- 会员状态、会员套餐、会员权益时间轴的 DTO 输出。

admin service 不再复制一份会员 DTO 映射逻辑，复用 billing adapter 或提取共享 adapter。

### `apps/api/src/interfaces/http`

`billing-routes.ts` 和 `admin-routes.ts` 的 `plan_key` schema 只接受 `MEMBERSHIP_PLAN_KEYS` 中的新 key。

`admin reward config` 的 legacy 单套餐字段 `membership` 继续读写兼容，但主结构是 `membership_plans`。当请求同时包含两者时，以 `membership_plans` 为准。响应中保留 `membership` 时，应始终等于 `membership_plans[0]` 的兼容投影。

所有钱包变动接口返回统一余额结构：

```ts
{
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
}
```

### `apps/api/src/runtime`

`ipc-worker.ts` 中队列优先级命名从业务上解释为 `hasPriorityQueue`，不要再用 `member` 判断其它能力。

Redis 队列 key 可以保留 `member` 字样以避免迁移运行中队列，但 TypeScript 变量和逻辑判断应改成 `priorityQueue` 语义。

微信 Claw 自动投递、账号绑定、消息处理只读取 `canUseWechatClaw`。Insight 进入优先队列不代表它可以使用微信 Claw。

### `apps/api/src/modules/system`

自配模型权限只读取 `canUseCustomModel`。自配模型平台服务费需要明确为一个产品决策：

- 如果自配模型也要收平台服务费，则 `custom_model_platform_price_per_million_coins` 必须进入 runtime price，并参与会员 allowance 抵扣。
- 如果自配模型不计平台服务费，则移除或隐藏该配置，避免 `billingMode = metered` 但价格为 0 的混乱状态。

本文建议保留平台服务费，并让它参与统一计费。

## 旧代码迁移清单

以下清单用于直接驱动 AI 修改。每一行都表示一个旧概念的完整收敛范围，不允许只改其中一个调用点。

| 旧符号或旧语义 | 目标状态 | 需要处理的位置 |
| --- | --- | --- |
| `fateclaw_plus` / `fateclaw_pro` 出现在业务写入入口 | HTTP 写入只接受 `MEMBERSHIP_PLAN_KEYS` 三个新 key；旧 key 只在 normalize 和历史 migration 中出现 | `apps/api/src/interfaces/http/billing-routes.ts`、`apps/api/src/interfaces/http/admin-routes.ts`、`apps/api/tests/interfaces/http/admin-routes.test.ts` |
| repository 查询排序显式识别旧 key | 保留为历史 DB 兼容，但注释说明只为旧数据兜底；写入参数必须 normalize 成新 key | `apps/api/src/infrastructure/repositories/billing-repository.ts` |
| 测试 fixture 大量使用旧 key | 业务行为测试改用新 key；只保留少量专门覆盖 legacy normalize 的测试 | `apps/api/tests/infrastructure/repositories/billing-repository.test.ts`、`apps/api/tests/modules/billing/plans.test.ts`、`apps/api/tests/modules/system/system-config.test.ts` |
| `plusGateBypass` | 改名为 `professionalAiQuotaBypass`，取值保留 `simple_workflow_first_turn` | `apps/api/src/modules/chat/chat-session-service.ts`、`apps/api/src/modules/chat/simple-workflow-service.ts`、对应 chat/simple workflow 测试 |
| `claimFreeProfessionalAiTurn()` / `releaseFreeProfessionalAiTurn()` | 新代码统一使用 `claimProfessionalAiTurn()` / `releaseProfessionalAiTurn()`；旧函数标 deprecated 并从主导出移除 | `apps/api/src/infrastructure/repositories/billing-repository.ts`、`apps/api/src/infrastructure/db.ts`、`apps/api/tests/infrastructure/repositories/billing-repository.test.ts` |
| `FreeProfessionalAi*` 类型 | 标 deprecated；新测试和新 service 类型使用 `ProfessionalAi*` | `apps/api/src/infrastructure/repositories/billing-repository.ts`、`apps/api/src/infrastructure/db.ts` |
| `free_professional_ai.daily_turn_limit` 作为主配置 | 后台兼容显示可以保留，但会员每日次数主规则来自 `resolveProfessionalAiDailyTurnLimit()` | `apps/api/src/modules/admin/admin-service.ts`、`apps/api/src/interfaces/http/admin-routes.ts`、`apps/admin/app/(dashboard)/system/reward-config-panel.tsx` |
| `available_coins = purchased + bonus` | 统一改为 `calculateAvailableSpendableCoins()`；必要时新增 `total_balance_coins` | `apps/api/src/modules/billing/plans.ts`、`apps/api/src/modules/billing/billing-service.ts`、`apps/api/src/modules/admin/admin-service.ts`、`apps/api/src/interfaces/http/admin-routes.ts`、`apps/api/src/infrastructure/repositories/billing-repository.ts` |
| 直接用 `purchased_coins + bonus_coins < 0` 判断欠费 | 使用统一钱包快照里的 `inArrears` 或 shared helper | `apps/api/src/modules/chat/chat-session-service.ts`、`apps/api/src/modules/billing/plans.ts` |
| `estimated_monthly_total_coins` 实际表示已结算费用 | 新增 `monthly_charged_coins`；旧字段保留并标 deprecated，值保持一致 | `packages/contracts/src/billing/index.d.ts`、`apps/api/src/modules/billing/billing-service.ts`、`apps/api/src/modules/admin/admin-service.ts`、`apps/admin/lib/admin-api.ts`、`apps/admin/app/(dashboard)/users/page.tsx` |
| admin stats `active_subscriptions` 实际统计会员 | 新增 `active_memberships`；旧字段兼容输出并标 deprecated | `apps/api/src/infrastructure/repositories/admin-repository.ts`、`apps/api/tests/infrastructure/repositories/admin-repository.test.ts`、`apps/admin/lib/admin-api.ts`、`apps/admin/app/(dashboard)/overview/page.tsx` |
| runtime 变量 `member` 被误当作任意会员 | TypeScript 语义改成 `priorityQueue` / `hasPriorityQueue`；Redis key 保留 `member` 作为运行兼容 | `apps/api/src/runtime/ipc-worker.ts` |
| 微信 Claw 用队列会员或泛化会员判断 | 只读取 `canUseWechatClaw` | `apps/api/src/runtime/ipc-worker.ts`、`apps/api/src/modules/account/account-http-service.ts`、`apps/api/src/modules/chat/message-handler.ts` |
| 自配模型用泛化会员判断 | 只读取 `canUseCustomModel`；同步决定自配模型平台费是否计费 | `apps/api/src/modules/system/system-config.ts`、`apps/api/src/interfaces/http/model-settings-routes.ts`、`packages/contracts/src/model-settings/index.d.ts` |
| `billing-contract.ts` passthrough | 改成实际 adapter，所有 billing/admin 会员 DTO 映射统一进入这里或共享 adapter | `apps/api/src/contracts-adapter/billing-contract.ts`、`apps/api/src/modules/billing/billing-service.ts`、`apps/api/src/modules/admin/admin-service.ts` |
| `membership_subscription` | 保留为历史 wallet transaction kind，不改 DB 值；新增注释说明它代表会员购买/续费流水，不代表 Skill subscription | `apps/api/src/infrastructure/repositories/billing-repository.ts`、`apps/admin/app/(dashboard)/billing/page.tsx` |

## 文件级执行说明

### `apps/api/src/shared/membership-plans.ts`

保留旧 key 常量和 legacy map，但只允许 normalize 函数使用。新增或修正中文注释，说明旧 key 不是可写入业务 key。

确认能力函数含义：

- `hasPaidMembershipEntitlement()`：Clarity 及以上。
- `hasExpertModeEntitlement()`：Clarity 及以上。
- `hasPriorityQueueEntitlement()`：Insight 及以上。
- `hasCustomModelEntitlement()`：Insight 及以上。
- `hasWechatClawEntitlement()`：Deep。
- `resolveProfessionalAiDailyTurnLimit()`：Free 0、Clarity 10、Insight 30、Deep 100。

### `apps/api/src/shared/balance-coins.ts`

把 `calculateAvailableSpendableCoins()` 作为所有 `available_coins` 的唯一计算函数。函数注释写清楚 `reserved_coins` 是历史冻结余额，但只要字段存在，`available_coins` 就必须扣它。

如果调用方需要展示未扣冻结余额，新增函数：

```ts
export function calculateTotalBalanceCoins(state: SpendableBalanceState): number {
  return state.purchased_coins + state.bonus_coins;
}
```

### `apps/api/src/infrastructure/repositories/billing-repository.ts`

保留 legacy 读取能力，收紧新写入路径。

具体要求：

- `subscribeMembershipWithWallet()` 入参先 normalize，但 HTTP schema 不再允许旧 key。
- `setUserMembershipForAdmin()` 的注释改掉“未知值回落到 Plus”，实际默认回落 Clarity 或由 HTTP schema 拦截。
- `getActiveMembershipsForUserUsing()` 和 `getMembershipOverview()` 中旧 key 排序保留，并加中文注释说明仅为历史数据兜底。
- `claimFreeProfessionalAiTurn()` / `releaseFreeProfessionalAiTurn()` 标 `@deprecated`，移出 `db.ts` 业务导出；仅历史测试或兼容脚本可直接 import repository。
- 余额返回值 `available_coins` 统一调用 `calculateAvailableSpendableCoins()`。
- 钱包流水 `membership_subscription` 附近添加中文注释，说明 DB kind 保留不改。

### `apps/api/src/infrastructure/db.ts`

从聚合导出中移除 Free 专家次数函数和类型，避免新业务继续从主入口使用旧 API。

保留 `claimProfessionalAiTurn()`、`releaseProfessionalAiTurn()`、`getFreeProfessionalAiQuotaConfig()`、`updateFreeProfessionalAiQuotaConfig()` 时，需要明确后两者仅服务后台旧配置兼容；如果后台同步移除旧配置，则一并移除后两者导出。

### `apps/api/src/modules/billing/plans.ts`

钱包 summary 使用统一 helper：

```ts
availableCoins: calculateAvailableSpendableCoins(user)
```

`reserveBillingForRequest()` 的欠费判断不直接写 `purchased + bonus < 0`，改为从统一钱包快照或 helper 判断。

`getMonthlyMeteredBillingSummary()` 返回的 `chargedCoins` 对外映射为 `monthly_charged_coins`。旧字段只在 contract adapter 里兼容输出。

### `apps/api/src/modules/billing/billing-service.ts`

不要在 service 内直接拼 snake_case DTO。改成构造内部 summary，然后调用 adapter：

- `toBillingStatusDto()`
- `toMembershipStatusDto()`
- `toMembershipPlanDto()`
- `toWalletBalanceDto()`
- `toMembershipSubscribeResultDto()`

这些函数在 `contracts-adapter/billing-contract.ts` 中实现。

### `apps/api/src/modules/admin/admin-service.ts`

admin 用户列表和详情中的 `available_coins` 使用统一 helper。

admin 用户列表和详情新增 `monthly_charged_coins`，保留 `estimated_monthly_total_coins` 兼容字段。

admin stats 新增 `active_memberships`，保留 `active_subscriptions` 兼容字段。后台 UI 优先读 `active_memberships`。

`membershipStatusToAdminView()` 和 `membershipPlanToAdminView()` 不再复制 billing adapter 逻辑，改用共享 adapter。

`free_professional_ai` 若保留，必须标为旧配置兼容，不参与 runtime 新每日次数规则。

### `apps/api/src/interfaces/http/billing-routes.ts`

`MembershipPlanKeySchema` 删除 `fateclaw_plus` 和 `fateclaw_pro`。旧 key 请求返回 400，由 schema 层拦截。

订阅返回 DTO 包含统一钱包字段。保持 `available_coins` 公式一致。

### `apps/api/src/interfaces/http/admin-routes.ts`

`MembershipPlanKeySchema` 删除旧 key。测试中旧 key 请求应改为断言 400；正常设置会员测试改用新 key。

余额发放和余额调整响应统一返回四个钱包字段。当前发放赠送余额响应缺少 `available_coins`，需要补齐。

reward config 请求同时带 `membership` 和 `membership_plans` 时，以 `membership_plans` 为准。只带 `membership` 时按兼容路径更新 `membership_plans[0]` 对应套餐。

### `apps/api/src/runtime/ipc-worker.ts`

新增或复用权益快照读取函数。`resolveInboxPriority()` 可以继续返回 `'member' | 'normal'` 以兼容 Redis key，但函数内部变量命名必须表达 `hasPriorityQueue`。

不得再用 `priority !== 'member'` 判断微信自动投递权限。微信相关判断只读 `canUseWechatClaw`。

AI Chat 和普通 IPC 都使用同一权益快照；避免一个请求内重复读会员并得到不同语义。

### `apps/api/src/modules/chat/chat-session-service.ts`

`plusGateBypass` 改名为 `professionalAiQuotaBypass`。调用方和测试同步改名。

专家 AI 每日次数从权益快照读取 `professionalAiDailyTurnLimit`。limit 为 0 返回开通 Clarity 或更高等级的错误；limit 大于 0 调用 `claimProfessionalAiTurn()`。

请求失败、抢占失败、runtime 失败时继续调用 `releaseProfessionalAiTurn()` 退回次数。

### `apps/api/src/modules/chat/simple-workflow-service.ts`

首轮简易模式继续旁路专家次数，但字段名改为 `professionalAiQuotaBypass: 'simple_workflow_first_turn'`。

### `apps/api/src/modules/account/account-http-service.ts`

账号绑定只读取 `canUseWechatClaw`。错误文案明确 Deep 权益，不再泛称会员。

### `apps/api/src/modules/chat/message-handler.ts`

微信消息入口只读取 `canUseWechatClaw`。没有 Deep 权益时返回统一的微信 Claw 不支持文案。

### `apps/api/src/modules/system/system-config.ts`

自配模型权限只读取 `canUseCustomModel`。如果保留平台服务费，`resolveUserLlmRuntime()` 中自配模型 runtime price 不得为 0，而应使用 `custom_model_platform_price_per_million_coins`。

如果产品决定不收自配模型平台费，则删除或隐藏该配置，并让 contract 不再暴露 `custom_model_platform_price_per_million_coins`。

### `packages/contracts`

`packages/contracts/src/billing/index.d.ts` 增加 `monthly_charged_coins`，并给 `estimated_monthly_total_coins` 加 `@deprecated` 注释。

如果 admin stats contract 在 `apps/admin/lib/admin-api.ts` 内维护，新增 `active_memberships`，`active_subscriptions` 标 deprecated。

### 前端和后台兼容改动

虽然本文重点是后端，但字段改名会影响前端类型和展示：

- `apps/admin/lib/admin-api.ts` 新增 `monthly_charged_coins`、`active_memberships`，旧字段保留。
- `apps/admin/app/(dashboard)/overview/page.tsx` 优先读 `active_memberships`。
- `apps/admin/app/(dashboard)/users/page.tsx` 优先读 `monthly_charged_coins`。
- `apps/admin/app/(dashboard)/system/reward-config-panel.tsx` 如果继续展示 `free_professional_ai`，文案标为旧兼容配置；如果移除旧配置，同步删表单项。
- `apps/web/features/billing/membership-plans.ts` 保留旧 key 只用于展示历史数据，不作为可购买 plan。
- `apps/web` 中所有余额展示继续读 `available_coins`，但后端公式统一后不用前端自行扣 `reserved_coins`。

## 数据库兼容边界

不为了命名洁癖重写全部历史表。以下对象保留，但只允许作为兼容读取或审计数据：

- `wallet_transactions.kind = membership_subscription`
- `wallet_transactions.metadata.planKey` 中的旧 key
- `membership_config.id = default`
- `ai_chat_free_daily_usage`
- `ai_chat_free_quota_config`
- 历史 migration 中的 `points`、`cents`、`yuan`

业务写入路径不得新增这些旧值。

需要数据修复时，新增 migration 只做幂等修复：

- 把残留 `fateclaw_plus` 会员记录合并到 `fateclaw_insight`。
- 把残留 `fateclaw_pro` 会员记录合并到 `fateclaw_deep`。
- 把旧 `ai_chat_free_daily_usage` 同步到 `ai_chat_professional_daily_usage`。
- 修复 wallet metadata 中旧 planKey。

## Contract 兼容策略

对外 contract 使用 snake_case，内部 service 可以使用 camelCase。转换只发生在 `contracts-adapter`。

保留兼容字段：

- `estimated_monthly_total_coins`：兼容旧前端，值等于 `monthly_charged_coins`。
- `membership`：admin reward config 的旧单套餐字段。
- `reserved_coins`：钱包响应保留，但文档明确是冻结余额。

废弃字段需要在 contract 注释中标 `@deprecated`，并在 API reference 中说明替代字段。

## 验证要求

字段和权益清理完成后，测试需要覆盖以下事实：

- HTTP 写入旧 plan key 会失败；DB 读取旧 key 仍能 normalize 成新 key。
- `available_coins` 在 auth、billing、admin、gift code、sign-in、recharge、grant、adjust 响应中公式一致。
- Clarity 有专家模式每日次数，但没有 runtime 优先队列、自配模型和微信 Claw。
- Insight 有优先队列和自配模型，但没有微信 Claw。
- Deep 有微信 Claw。
- `priorityQueue` 判断不影响 `canUseWechatClaw`。
- 专家 AI 次数只写 `ai_chat_professional_daily_usage`。
- 会员 allowance 抵扣和钱包扣款分别记录 `membership_allowance_use` 与 `overage_charge`。
- `estimated_monthly_total_coins` 和 `monthly_charged_coins` 在兼容期值一致。

涉及的测试文件至少包括：

- `apps/api/tests/interfaces/http/billing-routes.test.ts`
- `apps/api/tests/interfaces/http/admin-routes.test.ts`
- `apps/api/tests/modules/billing/billing-service.test.ts`
- `apps/api/tests/modules/billing/plans.test.ts`
- `apps/api/tests/modules/admin/admin-service.test.ts`
- `apps/api/tests/modules/chat/chat-session-service.test.ts`
- `apps/api/tests/modules/chat/simple-workflow-service.test.ts`
- `apps/api/tests/modules/system/system-config.test.ts`
- `apps/api/tests/runtime/ipc-worker.test.ts`
- `apps/api/tests/infrastructure/repositories/billing-repository.test.ts`
- `apps/api/tests/infrastructure/repositories/admin-repository.test.ts`

执行验收命令：

```bash
pnpm --filter @fateclaw/api typecheck
pnpm --filter @fateclaw/api test
pnpm --filter @fateclaw/api lint
```

如果同步改了 admin 或 web 类型，再执行：

```bash
pnpm --filter fateclaw-admin exec tsc --noEmit
pnpm --filter fateclaw-web exec tsc --noEmit
```

## 不属于本次清理的内容

本次不重构支付 provider、不重写 Skill 订阅模型、不调整前端视觉样式、不删除历史 migration 文件、不把所有 DB snake_case 类型改成 camelCase。

本次清理只收紧会员、余额、配额和 runtime 权限的业务边界，让后续代码只能沿着统一命名和统一快照扩展。
