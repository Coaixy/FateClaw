# 付费深度报告（Paid Deep Report）一次性实现规格

> 目标读者：接手实现的 AI coding agent。  
> 目标结果：在 FateClaw 中一次性落地「可预览、可购买、按章节生成、失败自动退款、前端可完整使用」的付费深度报告 MVP。  
> 重要约束：实现时所有新增代码注释、公开函数/类/接口文档注释必须使用中文；不做与本功能无关的重构。

---

## 0. 交付目标

FateClaw 当前主收入依赖会员订阅，但玄学场景更适合在用户情绪时刻售卖「正式、可拥有、有仪式感」的一次性深度命书。本功能要把已有确定性排盘 + AI 解读能力包装成付费报告商品。

MVP 完成后，用户路径必须成立：

1. 游客或登录用户访问 `/reports`。
2. 选择「节气运势简报」或「流年深度命书」。
3. 填写八字报告所需信息：公历出生日期、出生时间、性别、关注方向。
4. 免费看到真实排盘预览、章节大纲和首章营销钩子，不扣费。
5. 登录用户点击购买，余额足够时一次性扣固定价格。
6. 系统跳转/切换到现有 AI Chat 会话，按章节流式生成报告。
7. 每章是一轮 assistant 最终消息，前端显示章节徽标和订单进度。
8. 任一章节入队失败、生成失败或超时失败时，订单进入退款终态，钱包原路退回 bonus/purchased 两桶。
9. 成功完成后，订单状态为 `completed`，钱包流水只有 `report_purchase`，没有 token 二次扣费流水。
10. 报告页成为当前工作台体系的一等入口：侧边栏可达、Dashboard 有业务入口、AI Chat 能把高意图用户导向报告购买，购买后再回流到 AI Chat 完成交付。

---

## 1. 范围边界

### 1.1 MVP 必做

- 用户前端 `/reports` 商品页、预览表单、购买流程、余额不足提示、购买后进入 AI Chat。
- `/reports` 与现有体系融合：侧边栏固定入口、Dashboard 入口卡、AI Chat 高意图入口、充值后回跳。
- 高客单价路径：默认突出「流年深度命书」主力款，低价款作为入门备选，购买完成后在 AI Chat 承接追问/会员升级。
- 后端 `/api/reports` 用户接口：catalog、preview、purchase、orders。
- 数据库 `report_presets`、`report_orders`。
- 购买事务：扣钱包、建订单、建 chat session、写盘面消息、写购买流水。
- AI 章节编排：顺序生成、`billingMode:'none'`、CAS 推进、完成标记。
- 失败退款：章节入队失败、runtime final error、超时恢复失败都要全额退款。
- outbox 回调注册：不让 runtime 层直接 import `modules/chat/report-service.ts`。
- contracts：新增 `@fateclaw/contracts/report`，扩展 chat message metadata。
- 前端 chat 消息展示：报告章节徽标、报告进度 banner。
- 测试：仓储/服务/路由/前端 API 基础测试，至少覆盖扣费、退款、CAS、无 token 二扣。

### 1.2 MVP 不做

- 不做独立报告详情页；报告正文仍在 chat session messages 中。
- 不做 PDF/Word 导出。
- 不做真实免费首章生成后再解锁；MVP 只显示真实排盘 + 大纲 + 营销钩子。
- 不做完整 Admin 前端配置面板。先做 Admin API 或仓储能力，preset 由 migration seed 初始化；管理前端作为阶段 2。
- 不泛化 7 套排盘表单 UI。MVP 前端完整支持 seed 的八字类 preset；DB 结构保留 `paipan_skill` 扩展能力。
- 不改现有会员订阅、充值、Skill 市场主流程。

---

## 2. 现有架构依据

实现前先阅读这些文件：

- 仓库说明：[AGENT.md](/Users/coaixy/Documents/Code/FateClaw/AGENT.md)
- API 约定：[apps/api/src/interfaces/http/AGENT.md](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/interfaces/http/AGENT.md)
- Web 约定：[apps/web/AGENT.md](/Users/coaixy/Documents/Code/FateClaw/apps/web/AGENT.md)
- AI Chat service：[apps/api/src/modules/chat/chat-session-service.ts](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/modules/chat/chat-session-service.ts)
- 简易模式参考：[apps/api/src/modules/chat/simple-workflow-service.ts](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/modules/chat/simple-workflow-service.ts)
- 直接排盘参考：[apps/api/src/modules/chat/paipan-service.ts](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/modules/chat/paipan-service.ts)
- AI Chat outbox：[apps/api/src/runtime/ipc-ai-chat-outbox-handler.ts](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/runtime/ipc-ai-chat-outbox-handler.ts)
- 计费短路：[apps/api/src/modules/billing/plans.ts](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/modules/billing/plans.ts)
- 钱包仓储：[apps/api/src/infrastructure/repositories/billing-repository.ts](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/infrastructure/repositories/billing-repository.ts)
- migration 汇总：[apps/api/src/infrastructure/migrations/definitions.ts](/Users/coaixy/Documents/Code/FateClaw/apps/api/src/infrastructure/migrations/definitions.ts)

已核对的事实：

- `reserveBillingForRequest()` 在 `runtime.billingMode !== 'metered'` 时返回 `null`，不会冻结余额。
- `settleBillingReservationDetailed()` 在非 metered 时返回 0 扣费。
- `OwnedChatSessionTurnOptions` 已支持 `llmRuntimeOverride`、`runtimeUserMessageOverride`、`authorizedSkillBundleIds`、`authorizedWorkflowSkillIds`。
- `professionalAiQuotaBypass` 当前只有 `'simple_workflow_first_turn'`，需要扩为 `'simple_workflow_first_turn' | 'report_chapter'`。
- `sendOwnedChatSessionMessage()` 支持确定性 `userMessageId`，重复 ID 会返回 409。
- outbox final response 能从 pending/payload 解析 `sessionId` 和 `userMessageId`。
- outbox final metadata 会合并 `payload.metadata`；报告章节需要新增内部 metadata 透传选项，把章节信息放入 AI Chat IPC payload。
- 当前最高 migration id 是 `0048_user_skill_runtime_limit`，新 migration 从 `0049` 开始。
- `wallet_transactions.request_id` 没有唯一约束，不能把它当唯一幂等保护；幂等必须靠 `report_orders.order_no UNIQUE` 和订单行锁。

---

## 3. 产品与前端体验设计

### 3.1 页面位置与体系融合

`/reports` 不是独立营销页，也不是设置页的一部分。它是当前 AppShell 内的「付费命书购买工具」，和 `/ai-chat`、`/dashboard`、`/wallet` 同级。

必须使用现有外壳：

- `apps/web/app/reports/page.tsx` 渲染 `AppShell wide`。
- 页面主体放在 AppShell 内容区内，不能绕过侧边栏、TopBar、登录态和全局错误边界。
- 游客可以访问 catalog 和 preview；购买动作必须要求登录。若 AppShell 默认强制登录，需要给报告页明确使用 `requireAuth={false}`，并在购买 CTA 层处理登录跳转。
- `/reports` 是公开可访问页面，`apps/web/components/app-shell.tsx` 的 `ComplianceFooterSlot` 需要把 `/reports` 纳入备案页脚展示条件。

入口优先级：

1. 侧边栏固定入口：在 `apps/web/components/sidebar.tsx` 增加「命书报告」入口，路径 `/reports?source=sidebar`，位置放在归档/新建对话下方、会话列表上方。它是收入入口，不能只放在底部快捷区。
2. AI Chat 高意图入口：在 `apps/web/components/ai-chat/ai-chat-workspace.tsx` 的 `HomeModeSelector` 增加第三张入口卡，和当前「快速开始」「专业排盘」同级，指向 `/reports?source=ai_chat_empty`。文案要偏业务，例如「生成完整命书报告」，不要写成长篇功能说明。
3. Dashboard 入口卡：在 `apps/web/components/dashboard/workspace-dashboard.tsx` 顶部增加一块轻量入口，放在微信连接模块之前，指向 `/reports?source=dashboard`。Dashboard 当前用于工作台能力聚合，报告入口应作为付费业务入口出现。
4. 充值回跳：余额不足时跳 `/wallet?return_to=%2Freports%3Fpreset_id%3D<id>%26source%3Dwallet_return&amount=<缺口积分>`，充值完成后能回到原 preset。
5. 登录回跳：未登录购买时使用现有 `buildLoginHref()` / `next` 参数，不使用 `return_to`。

不要把入口分散到 `/membership`、`/discover` 或 Skill 安装页。会员、技能市场是不同购买心智；报告页要承接“我现在想看完整命书”的即时需求。

入口来源必须透传：

- `/reports` 读取 query：`preset_id` 和 `source`。
- `source` 只接受白名单：`sidebar`、`dashboard`、`ai_chat_empty`、`ai_chat_report_done`、`wallet_return`、`direct`。
- `POST /api/reports/purchase` 把来源写入 `report_orders.metadata.entry_source`，用于后续统计不同入口的客单价和转化率。

### 3.2 客单价策略

报告页要以提高客单价为目标设计，而不是平均展示两个商品。

商品角色：

- `solar-term-bazi-brief`：低价入门款，解决新用户第一次付费阻力。展示为「适合先试一次」。
- `annual-bazi-deep`：主力高客单款，默认选中，视觉权重更高。展示为「更完整」「6 章」「年度主线」。

默认行为：

- catalog 加载后默认选中 `annual-bazi-deep`，除非 URL 携带 `preset_id`。
- 商品排序仍遵守 `sort_order`，但主力款卡片要有 `主力` 徽标和更明显 CTA。
- 预览区同时服务两个 SKU：用户看完预览后，主 CTA 优先购买当前选中的主力款；若当前选中低价款，在 CTA 附近给出一个次级按钮「升级为流年深度命书」，切换到 `annual-bazi-deep`，不直接二次弹窗。

价格呈现：

- 价格统一用积分/软妹币格式，不写“token”。
- 低价款强调低门槛，高价款强调完整章节和年度行动清单。
- 不要做虚假倒计时、夸张折扣或恐吓文案。

购买后的承接：

- 购买成功必须回流 `/ai-chat?sid=<sessionId>`，因为正文交付发生在现有 AI Chat 体系。
- 简易模式或普通解读完成后，如果当前会话还不是 `paid_report`，可以在已有完成态轻提示附近放一个轻量链接 `生成完整命书报告`，指向 `/reports?source=ai_chat_report_done`。不要弹窗，不要插入机器人广告消息。
- 报告完成后，AI Chat 进度 banner 结束态可提供两个轻量操作：`继续追问本报告`、`开通会员获得日常解读额度`。MVP 只需要链接，不做自动弹窗。
- 如果用户买了低价款，完成态 banner 可提供 `解锁流年深度命书` 链接到 `/reports?preset_id=annual-bazi-deep&source=ai_chat_report_done`。

MVP 要能通过 SQL 回答三个业务问题：

1. 哪个入口带来的订单最多：按 `report_orders.metadata->>'entry_source'` 分组。
2. 哪个入口客单价最高：按 `AVG(price_coins)` 分组。
3. 低价款是否带来主力款升级：同一 `user_id` 先买 `solar-term-bazi-brief`，后买 `annual-bazi-deep` 的订单数。

不需要本次做前端数据看板，但订单 metadata 必须为这些查询留好字段。

可用于验收的 SQL 示例：

```sql
SELECT
  COALESCE(metadata->>'entry_source', 'direct') AS entry_source,
  COUNT(*) AS orders,
  AVG(price_coins) AS avg_price_coins,
  SUM(price_coins) AS gross_coins
FROM report_orders
WHERE status IN ('generating', 'completed')
GROUP BY 1
ORDER BY gross_coins DESC;
```

```sql
SELECT COUNT(*) AS upgraded_users
FROM (
  SELECT user_id
  FROM report_orders
  WHERE preset_id IN ('solar-term-bazi-brief', 'annual-bazi-deep')
    AND status IN ('generating', 'completed')
  GROUP BY user_id
  HAVING MIN(created_at) FILTER (WHERE preset_id = 'solar-term-bazi-brief')
       < MAX(created_at) FILTER (WHERE preset_id = 'annual-bazi-deep')
) t;
```

### 3.3 页面信息架构

新增用户页面：

- `apps/web/app/reports/page.tsx`

页面结构：

1. 顶部紧凑标题区：标题「命书报告」、副标题「先看盘面，再决定是否解锁完整章节」。
2. 商品区：两个 preset 卡片。
3. 购买流区域：选中商品后显示输入表单、预览、章节大纲和 CTA。
4. 登录/余额状态：根据购买结果显示登录提示、余额不足提示或跳转会话。
5. 最近订单区：登录用户在页面底部显示最近 3 条报告订单，可直接回到对应 AI Chat 会话。

不要做营销 landing page，不要做大 hero，不要做和业务无关的装饰插画。这个页面是工作台内的商品购买工具，要信息密度清晰。

### 3.4 视觉风格

沿用 `apps/web` 现有风格：

- 使用现有 CSS 变量、卡片边框、按钮和字体层级。
- 卡片圆角不超过现有系统，优先 `rounded-xl` 或更小。
- 商品卡不互相嵌套，不把整页套进大卡片。
- 主色不要做单一紫蓝渐变；报告页使用中性底色 + 少量金色/朱砂色强调。
- 按钮使用图标时优先 lucide-react 已有图标。
- 移动端必须单列，预览内容和 CTA 不得遮挡。

### 3.5 响应式布局

桌面端：

- 内容宽度使用 `AppShell wide` 下的 `max-w-[1400px]` 约束。
- 页面主体采用 12 栏思路：左侧 4 栏为商品卡和输入表单，右侧 8 栏为预览、章节大纲和购买 CTA。
- 购买 CTA 在右侧内容底部随内容流动，不做 fixed/sticky 浮层，避免遮挡预览。
- 预览成功前，右侧显示紧凑空状态：`填写出生信息后先看盘面预览`。

移动端：

- 单列顺序为：标题、商品横向滚动/两张卡、表单、预览、章节大纲、CTA。
- 商品卡使用稳定高度，切换选中态不能造成布局跳动。
- CTA 不固定在底部，避免遮挡输入法和预览内容。

### 3.6 商品卡片

每张商品卡显示：

- 报告名称。
- 价格，例如 `软妹币 9.90`。
- 简短 summary。
- 章节数，例如 `3 章` / `6 章`。
- 标签：`引流`、`主力`、`八字`。
- 选中态：边框和背景轻微高亮。

点击卡片后，不跳页，只更新右侧/下方购买流。

### 3.7 八字报告输入表单

MVP 只保证八字类 preset 完整可用。字段：

- `solarDate`: `<input type="date">`，必填。
- `hour`: 0-23 选择器，必填。
- `minute`: 0/15/30/45 快捷分段 + 可输入 0-59，默认 0。
- `gender`: segmented control，男/女。
- `focus`: 文本框，必填，placeholder 例如「今年事业和感情有什么需要注意？」。

提交预览时请求：

```json
{
  "preset_id": "annual-bazi-deep",
  "paipan_input": {
    "solarDate": "1995-03-12",
    "hour": 9,
    "minute": 0,
    "gender": "女"
  },
  "focus": "今年事业和感情有什么需要注意？"
}
```

### 3.8 免费预览

预览成功后显示三块内容：

1. 盘面预览：复用现有 artifact renderer 能力展示 `skillContextEntry`，如果直接复用成本太高，先显示 `artifactTitle` + `output` 文本，不阻塞 MVP。
2. 章节大纲：只显示标题和一句短说明，不显示章节正文。
3. 首章钩子：来自 preset 的 `preview_hook`，是固定营销文案，不调用 AI 生成。

CTA 文案：

- 登录用户：`{price} 解锁完整 {chapters_total} 章`
- 未登录用户：`登录后解锁完整报告`
- 余额不足后：`余额不足，去充值`

### 3.9 购买成功后的跳转

`POST /api/reports/purchase` 成功返回 `session` 和 `order`。前端行为：

1. 跳转到 `/ai-chat?sid=<sessionId>`。
2. 由现有 `use-chat-sessions.ts` 从 URL 读取选中 session。
3. AI Chat 页面顶部显示报告进度 banner。
4. AI Chat 必须能在“用户没有手动点击发送”的情况下继续接收/轮询后台章节生成。

不要让 `/reports` 页面强依赖 ChatSessionsProvider；如果当前 layout 已经提供 provider，可以顺手 `touchSession(result.session)`，但跳转 URL 是必须的恢复路径。

### 3.10 AI Chat 中的报告展示

修改 `apps/web/components/ai-chat/ai-chat-message-list.tsx` 或其消息 item 子组件的显示逻辑：

- 当 final assistant message 的 `metadata.workflow === 'paid_report'` 且有 `chapter_index` 时，显示小徽标：`第 {chapter_index + 1} 章 · {chapter_title}`。
- 报告章节消息仍按普通 assistant Markdown 渲染。
- 不为报告创建新 renderer。

新增报告进度 banner：

- 位置：AI Chat 工作区消息列表上方，composer 下方不要遮挡。
- 显示条件：当前会话存在 `metadata.workflow === 'paid_report'` 的消息，或 `use-report-order` 根据 session/order 查到 active/completed/refunded 订单。
- 内容：
  - `generating`: `正在生成《{preset_name}》 · {chapters_done}/{chapters_total}`
  - `completed`: `报告已完成 · {chapters_total}/{chapters_total}`
  - `refunded`: `生成失败，已全额退款`
- Banner 不显示使用说明、快捷键等解释性文案。

### 3.11 余额不足与充值

购买接口 402 时返回：

```json
{
  "error": "余额不足，请充值后继续",
  "required_coins": 99,
  "available_coins": 12.5
}
```

前端可先做最小实现：

- 显示错误 toast 和内联提示。
- 提供「去充值」按钮跳 `/wallet?return_to=%2Freports%3Fpreset_id%3D<id>%26source%3Dwallet_return&amount=<缺口积分>`。
- 不要求在报告页内嵌完整充值浮层；内嵌浮层可作为后续优化。

### 3.12 文案与多语言

前端必须补齐 `apps/web/lib/i18n/messages/zh-cn.ts`、`zh-tw.ts`、`en.ts`，不要在组件里硬编码中文。

新增 key 建议：

- `sidebar.reports`: `命书报告`
- `pages.reports.title`: `命书报告`
- `pages.reports.subtitle`: `先看盘面，再决定是否解锁完整章节`
- `pages.reports.primaryBadge`: `主力`
- `pages.reports.entryBadge`: `引流`
- `pages.reports.preview`: `查看免费预览`
- `pages.reports.purchase`: `{price} 解锁完整 {chapters} 章`
- `pages.reports.loginToPurchase`: `登录后解锁完整报告`
- `pages.reports.upgradeAnnual`: `升级为流年深度命书`
- `pages.reports.insufficientBalance`: `余额不足，请充值后继续`
- `pages.reports.returnFromWallet`: `返回命书报告`
- `pages.reports.recentOrders`: `最近报告`
- `pages.reports.continueOrder`: `查看报告`
- `pages.reports.statusGenerating`: `生成中`
- `pages.reports.statusCompleted`: `已完成`
- `pages.reports.statusRefunded`: `已退款`
- `aiChat.report.emptyCta`: `生成完整命书报告`
- `aiChat.report.afterAnswerCta`: `生成完整命书报告`
- `aiChat.report.generating`: `正在生成《{name}》 · {done}/{total}`
- `aiChat.report.completed`: `报告已完成 · {total}/{total}`
- `aiChat.report.refunded`: `生成失败，已全额退款`
- `aiChat.report.continueAsk`: `继续追问本报告`
- `aiChat.report.openMembership`: `开通会员获得日常解读额度`
- `aiChat.report.upgradeAnnual`: `解锁流年深度命书`
- `pages.wallet.badgeReportPurchase`: `命书`
- `pages.wallet.badgeReportRefund`: `退款`

英文和繁体可以先做语义准确的直译，不需要营销化改写。

---

## 4. 数据库设计

### 4.1 Migration

新增：

- `apps/api/src/infrastructure/migrations/definitions/0049-paid-reports.ts`
- 在 `apps/api/src/infrastructure/migrations/definitions.ts` import `paidReportMigrations` 并追加到 `MIGRATIONS` 末尾。

Migration id：

- `0049_paid_reports`

### 4.2 `report_presets`

用途：后台可配置的报告商品类型。MVP 由 seed 初始化，不做用户前端动态编辑。

字段：

```sql
CREATE TABLE IF NOT EXISTS report_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  badge TEXT DEFAULT NULL,
  paipan_skill TEXT NOT NULL,
  paipan_input_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  price_coins NUMERIC(14,2) NOT NULL,
  model_policy JSONB NOT NULL DEFAULT '{"mode":"system-default"}'::jsonb,
  skill_bundle_ids TEXT[] NOT NULL DEFAULT '{}',
  skill_ids TEXT[] NOT NULL DEFAULT '{}',
  skill_snapshot_ids TEXT[] NOT NULL DEFAULT '{}',
  chapters JSONB NOT NULL,
  preview_hook TEXT NOT NULL DEFAULT '',
  free_preview_chapters INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

约束：

- `price_coins > 0`
- `jsonb_typeof(chapters) = 'array'`
- `jsonb_array_length(chapters) > 0`
- `jsonb_typeof(paipan_input_defaults) = 'object'`
- `jsonb_typeof(model_policy) = 'object'`
- `paipan_skill IN ('bazi-paipan','ziwei-paipan','iching-paipan','jingzhan-paipan','meihua-paipan','liuren-paipan','qimen-paipan')`

索引：

- `(enabled, sort_order, id)`
- `(paipan_skill)`

`chapters` 元素结构：

```json
{
  "key": "overview",
  "title": "命局总览",
  "summary": "先建立整体结构和本年主线。",
  "prompt_template": "你正在生成付费报告《{{preset_name}}》第 {{chapter_number}} 章..."
}
```

模板变量必须支持：

- `{{preset_name}}`
- `{{chapter_number}}`
- `{{chapter_title}}`
- `{{focus}}`
- `{{board_title}}`

不要把排盘全文手动拼进 prompt；让 `selectedBoardMessageId` 注入盘面上下文。
`model_policy.mode` 沿用简易模式已有枚举：`system-default`、`user-current`、`fixed`。

### 4.2.1 `preset_snapshot` 结构

`report_orders.preset_snapshot` 必须保存购买时会影响后续章节生成的所有字段。后续章节不能再读当前 `report_presets`，否则后台改 preset 会影响已购买订单。

建议结构：

```json
{
  "preset": {
    "id": "annual-bazi-deep",
    "name": "流年深度命书",
    "badge": "主力",
    "paipan_skill": "bazi-paipan",
    "model_policy": { "mode": "system-default" },
    "skill_bundle_ids": [],
    "skill_ids": [],
    "skill_snapshot_ids": [],
    "chapters": []
  },
  "request": {
    "focus": "今年事业和感情有什么需要注意？",
    "board_title": "八字排盘"
  }
}
```

注意：

- `request.focus` 必须保存，因为每一章 prompt 都要用 `{{focus}}`。
- 不要把完整出生日期、出生时间、性别写入 `report_orders.metadata` 或钱包流水 metadata。
- 原始排盘输入和盘面结果只存在当前 AI Chat 会话的 `board_request` / `board_result` 消息上下文中，避免订单表和流水表扩散敏感出生信息。

### 4.3 `report_orders`

用途：购买订单、生成进度、退款状态的唯一业务真相。

字段：

```sql
CREATE TABLE IF NOT EXISTS report_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  preset_id TEXT NOT NULL,
  preset_snapshot JSONB NOT NULL,
  price_coins NUMERIC(14,2) NOT NULL,
  wallet_used_coins NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonus_deducted_coins NUMERIC(14,2) NOT NULL DEFAULT 0,
  purchased_deducted_coins NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  session_id TEXT DEFAULT NULL,
  board_message_id TEXT DEFAULT NULL,
  chapters_total INTEGER NOT NULL,
  chapters_done INTEGER NOT NULL DEFAULT 0,
  current_chapter_index INTEGER DEFAULT NULL,
  current_user_message_id TEXT DEFAULT NULL,
  failure_reason TEXT DEFAULT NULL,
  refunded_at TIMESTAMPTZ DEFAULT NULL,
  completed_at TIMESTAMPTZ DEFAULT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

状态枚举：

- `generating`: 已扣费，正在生成。
- `completed`: 全部章节完成，终态。
- `refunded`: 生成失败且退款完成，终态。

不要使用 `failed` 作为终态，避免和 `refunded` 互相覆盖。失败原因写入 `failure_reason`，退款终态统一为 `refunded`。

约束：

- `status IN ('generating','completed','refunded')`
- `price_coins > 0`
- `wallet_used_coins >= 0`
- `bonus_deducted_coins >= 0`
- `purchased_deducted_coins >= 0`
- `chapters_total > 0`
- `chapters_done >= 0`
- `chapters_done <= chapters_total`
- `current_chapter_index IS NULL OR (current_chapter_index >= 0 AND current_chapter_index < chapters_total)`

索引：

- `(user_id, created_at DESC)`
- `(session_id)`，用于 outbox 反查。
- `(status, created_at DESC)`，用于恢复/后台排障。
- `(current_user_message_id)`，用于调试和可选反查。

### 4.4 Seed preset

Seed 两个八字类 preset，使用 `ON CONFLICT (id) DO UPDATE`，便于部署后自动初始化。

#### `solar-term-bazi-brief`

- name: `节气运势简报`
- price: `9.90`
- badge: `引流`
- paipan_skill: `bazi-paipan`
- chapters: 3 章
  1. `overview`: `当前命局与近期主线`
  2. `opportunity`: `机会、阻力与行动窗口`
  3. `advice`: `未来三十天建议`

#### `annual-bazi-deep`

- name: `流年深度命书`
- price: `99.00`
- badge: `主力`
- paipan_skill: `bazi-paipan`
- chapters: 6 章
  1. `overview`: `命局底色与年度主线`
  2. `career`: `事业、学业与财富机会`
  3. `relationship`: `关系、亲密与合作`
  4. `health`: `身心状态与节律提醒`
  5. `risk`: `风险月份与关键选择`
  6. `action_plan`: `年度行动清单`

Prompt 要求：

- 明确是付费报告章节。
- 语气正式、具体、可读。
- 不恐吓，不保证绝对结果，不给医疗/法律/投资确定性建议。
- 每章围绕本章标题生成，不重复上一章大段内容。
- 输出 Markdown，标题使用 `##`，不要输出 token 计费说明。

---

## 5. Contracts 设计

### 5.1 新增 report contract

新增：

- `packages/contracts/src/report/index.d.ts`
- `packages/contracts/package.json` exports 加 `"./report": "./src/report/index.d.ts"`
- `packages/contracts/src/index.d.ts` export `./report/index.js`

DTO 全部 snake_case。

```ts
import type { ChatSessionDto, MessageDto, SkillContextEntryDto } from '../chat/index.js';

export type ReportOrderStatusDto = 'generating' | 'completed' | 'refunded';

export type ReportEntrySourceDto =
  | 'sidebar'
  | 'dashboard'
  | 'ai_chat_empty'
  | 'ai_chat_report_done'
  | 'wallet_return'
  | 'direct';

export interface ReportChapterPublicDto {
  key: string;
  title: string;
  summary?: string;
}

export interface ReportChapterDefDto extends ReportChapterPublicDto {
  prompt_template?: string;
}

export interface ReportPresetPublicDto {
  id: string;
  name: string;
  summary: string;
  enabled: boolean;
  sort_order: number;
  badge?: string | null;
  paipan_skill: string;
  price_coins: number;
  chapters: ReportChapterPublicDto[];
  preview_hook: string;
}

export interface ReportPresetAdminDto extends ReportPresetPublicDto {
  paipan_input_defaults: Record<string, unknown>;
  model_policy: Record<string, unknown>;
  skill_bundle_ids: string[];
  skill_ids: string[];
  skill_snapshot_ids: string[];
  free_preview_chapters: number;
  metadata: Record<string, unknown>;
}

export interface ReportCatalogResponseDto {
  presets: ReportPresetPublicDto[];
}

export interface ReportPreviewRequestDto {
  preset_id: string;
  paipan_input: Record<string, unknown>;
  focus: string;
}

export interface ReportPreviewResponseDto {
  preset: ReportPresetPublicDto;
  skill_context_entry: SkillContextEntryDto;
  chapters: ReportChapterPublicDto[];
  preview_hook: string;
  expires_at?: string;
}

export interface ReportPurchaseRequestDto {
  preset_id: string;
  paipan_input: Record<string, unknown>;
  focus: string;
  entry_source?: ReportEntrySourceDto;
}

export interface ReportOrderDto {
  id: string;
  order_no: string;
  preset_id: string;
  preset_name: string;
  price_coins: number;
  wallet_used_coins: number;
  status: ReportOrderStatusDto;
  session_id?: string | null;
  chapters_total: number;
  chapters_done: number;
  current_chapter_index?: number | null;
  failure_reason?: string | null;
  refunded_at?: string | null;
  completed_at?: string | null;
  entry_source?: ReportEntrySourceDto | null;
  created_at: string;
  updated_at: string;
}

export interface ReportStartResponseDto {
  order: ReportOrderDto;
  session: ChatSessionDto;
  board_message: MessageDto;
}

export interface ReportOrdersResponseDto {
  orders: ReportOrderDto[];
}

export interface ReportPresetUpsertRequestDto {
  id: string;
  name: string;
  summary?: string;
  enabled?: boolean;
  sort_order?: number;
  badge?: string | null;
  paipan_skill: string;
  paipan_input_defaults?: Record<string, unknown>;
  price_coins: number;
  model_policy?: Record<string, unknown>;
  skill_bundle_ids?: string[];
  skill_ids?: string[];
  skill_snapshot_ids?: string[];
  chapters: ReportChapterDefDto[];
  preview_hook?: string;
  free_preview_chapters?: number;
  metadata?: Record<string, unknown>;
}
```

### 5.2 扩展 chat metadata

在 `packages/contracts/src/chat/index.d.ts` 的 `MessageMetadataDto` 增加：

```ts
report_order_id?: string;
report_order_no?: string;
chapter_index?: number;
chapter_key?: string;
chapter_title?: string;
report_status?: 'generating' | 'completed' | 'refunded';
```

### 5.3 扩展 billing contract

为支持余额不足后充值回到报告页，在 `packages/contracts/src/billing/index.d.ts` 的 `RechargeOrderDto` 增加：

```ts
return_to?: string | null;
```

只暴露校验后的站内路径，不暴露充值订单完整 metadata。

---

## 6. 后端仓储设计

### 6.1 文件

新增：

- `apps/api/src/infrastructure/repositories/report-repository.ts`

修改：

- `apps/api/src/infrastructure/db.ts` re-export 新仓储函数和类型。
- `apps/api/src/infrastructure/repositories/chat-repository.ts` 增加 client-aware helper。

### 6.2 必须增加 chat repository 的事务版本

当前 `createChatSession()`、`storeMessage()` 使用全局 pool，不能直接参与购买事务。为避免扣费成功但会话/盘面消息失败造成不一致，必须新增内部 helper：

```ts
export async function createChatSessionUsing(
  client: pg.PoolClient,
  session: { id: string; accountId: string; userId: string; title: string },
): Promise<ChatSession>;

export async function storeMessageUsing(
  client: pg.PoolClient,
  msg: NewMessage,
): Promise<void>;

export async function touchChatSessionUsing(
  client: pg.PoolClient,
  id: string,
): Promise<void>;
```

保留原函数，并让原函数调用对应 `Using` 版本，减少重复 SQL。

### 6.3 Preset CRUD

仓储函数：

- `listPublicReportPresets(): Promise<ReportPresetRow[]>`
- `getReportPresetById(id: string): Promise<ReportPresetRow | undefined>`
- `listReportPresetsForAdmin(): Promise<ReportPresetRow[]>`
- `upsertReportPresetForAdmin(input): Promise<ReportPresetRow>`
- `setReportPresetEnabled(id: string, enabled: boolean): Promise<ReportPresetRow>`

行数据 normalize：

- `price_coins` 转 number。
- JSONB 字段确保 object/array 默认值。
- TEXT[] 字段确保 string[]。
- public DTO 必须剥离 `chapters[].prompt_template`，不要把完整提示词返回给用户端。

### 6.4 订单查询

仓储函数：

- `getReportOrderByOrderNoForUser(orderNo, userId)`
- `listReportOrdersByUser(userId, limit, offset)`
- `getReportOrderBySessionId(sessionId)`
- `getReportOrderByCurrentUserMessageId(userMessageId)` 可选。
- `listStaleGeneratingReportOrders(cutoffIso, limit)` 用于恢复。

所有 user-facing 查询必须校验 `user_id`。

`ReportOrderDto.entry_source` 从 `report_orders.metadata.entry_source` 映射，输出前仍按 `ReportEntrySourceDto` 白名单校验；非法值输出 `direct` 或 `null`。

### 6.5 购买事务

函数签名：

```ts
export async function purchaseReportWithWallet(input: {
  userId: string;
  preset: ReportPresetRow;
  prepared: {
    presetSnapshot: ReportPresetSnapshot;
    priceCoins: number;
    runtimeId: string;
    sessionTitle: string;
    requestSummary: string;
    boardSkillContextEntry: SkillContextEntryDto;
    metadata: Record<string, unknown>;
  };
}): Promise<{
  order: ReportOrderRow;
  session: ChatSession;
  boardMessage: NewMessage;
}>;
```

执行顺序：

1. `BEGIN`
2. `SELECT users ... FOR UPDATE`
3. `deductBalanceCoins(client, normalizeUserCoins(user), priceCoins)`
4. `INSERT report_orders status='generating'`，`metadata` 使用 `prepared.metadata`，至少包含 `entry_source`
5. `createChatSessionUsing(client, ...)`
6. 写 `board_request` message，metadata 包含 `workflow:'paid_report'`、`report_order_id`、`report_order_no`。
7. 写 `board_result` message，`tool_context` 包含 `SkillContextEntryDto`，metadata 包含 preset 快照摘要。
8. `UPDATE report_orders SET session_id, board_message_id`
9. `insertWalletTransaction(client, { kind:'report_purchase', amountCoins:-priceCoins, balanceSource: deduction.balanceSource, requestId: order_no, metadata:{ bonusDeducted, purchasedDeducted, presetId, entrySource } })`
10. `COMMIT`

注意：

- `wallet_transactions.request_id` 不是唯一约束，幂等靠 `report_orders.order_no UNIQUE`。不要在失败重试时重复创建新 order_no。
- MVP purchase 接口不接收客户端幂等键，服务端每次点击创建新订单；前端按钮 pending 时禁用，避免重复点击。后续可加 client_request_id。
- `report_orders.metadata` 使用 snake_case，例如 `entry_source`；`wallet_transactions.metadata` 跟随现有仓储风格，可使用 camelCase，例如 `entrySource`。
- `wallet_transactions.kind` 当前没有枚举约束，不需要为 `report_purchase` / `report_refund` 加 migration；但两种流水都必须显式传 `balanceSource`，不要依赖 `inferBalanceSourceFromKind()` 默认推断。

### 6.6 设置当前章节

```ts
export async function markReportChapterInFlight(input: {
  orderNo: string;
  chapterIndex: number;
  userMessageId: string;
}): Promise<ReportOrderRow | null>;
```

SQL 条件：

```sql
UPDATE report_orders
SET current_chapter_index = $2,
    current_user_message_id = $3,
    updated_at = NOW()
WHERE order_no = $1
  AND status = 'generating'
  AND chapters_done = $2
RETURNING *
```

### 6.7 CAS 推进

```ts
export async function advanceReportOrderChapter(input: {
  orderNo: string;
  expectedChaptersDone: number;
  userMessageId: string;
}): Promise<ReportOrderRow | null>;
```

SQL 条件：

```sql
UPDATE report_orders
SET chapters_done = chapters_done + 1,
    current_chapter_index = NULL,
    current_user_message_id = NULL,
    updated_at = NOW()
WHERE order_no = $1
  AND status = 'generating'
  AND chapters_done = $2
  AND current_user_message_id = $3
RETURNING *
```

0 行代表已推进、状态已变更或 userMessageId 不匹配，调用方直接 return。

### 6.8 完成订单

```ts
export async function completeReportOrder(orderNo: string): Promise<ReportOrderRow | null>;
```

SQL 条件：

```sql
UPDATE report_orders
SET status = 'completed',
    completed_at = NOW(),
    current_chapter_index = NULL,
    current_user_message_id = NULL,
    updated_at = NOW()
WHERE order_no = $1
  AND status = 'generating'
  AND chapters_done = chapters_total
RETURNING *
```

### 6.9 退款事务

函数：

```ts
export async function refundReportOrder(input: {
  orderNo: string;
  reason: string;
}): Promise<ReportOrderRow>;
```

执行：

1. `BEGIN`
2. `SELECT report_orders WHERE order_no=$1 FOR UPDATE`
3. 若 `status === 'refunded'`，`COMMIT` 幂等返回。
4. 若 `status === 'completed'`，直接 `COMMIT` 并返回当前订单，不对完成订单退款。
5. `UPDATE users SET purchased_coins += purchased_deducted_coins, bonus_coins += bonus_deducted_coins`
6. 插入 `report_refund` 流水，`amountCoins = wallet_used_coins`，`balanceSource` 按原扣款组合写，`requestId = order_no`，metadata 至少包含 `presetId`、`entrySource`、`refundReason`。
7. `UPDATE report_orders SET status='refunded', failure_reason=$reason, refunded_at=NOW(), current_* = NULL`
8. `COMMIT`

MVP 不重建 `balance_grants.remaining_coins`，只退回 `users.bonus_coins`。这是已接受的精度取舍；在代码注释中用中文说明原因。

### 6.10 充值回跳字段

为支持报告页余额不足后的充值回流，修改现有充值链路：

- `createRechargeOrderForUser(input)` 增加 `returnTo?: unknown`。
- 新增内部 helper `normalizeRechargeReturnTo(value)`，语义与前端 `normalizeReturnTo()` 一致，只允许安全站内路径。
- `insertRechargeOrder()` 的 metadata 增加：

```ts
{
  client_ip: input.clientIp,
  return_to: normalizedReturnTo,
}
```

- `toRechargeOrderDto(row)` 从 `row.metadata.return_to` 读取安全字符串，映射为 `return_to`。
- 不要把充值订单完整 metadata 暴露给前端。

---

## 7. 后端业务服务设计

### 7.1 文件

新增：

- `apps/api/src/modules/chat/report-service.ts`

### 7.1.1 AI Chat metadata 透传

报告章节 final message 必须带 `workflow:'paid_report'`、`report_order_no`、`chapter_index` 等 metadata，否则前端无法显示章节徽标和进度。当前 outbox 已经会把 `ResponseIpcPayload.metadata` 合并进 final metadata，但 `sendOwnedChatSessionMessage()` 没有内部选项把 workflow metadata 传给 IPC payload。

需要补一条最小透传链路：

1. 在 `OwnedChatSessionTurnOptions` 增加：

```ts
/** 内部 workflow 写入最终 assistant metadata 的字段；不会暴露给普通 HTTP 请求体。 */
responseMetadata?: Record<string, unknown>;
```

2. 在 `PreparedOwnedChatSessionTurn` 保存 `responseMetadata`。
3. 在 `dispatchAiChatPrompt()` / `submitAiChatInboxRequest()` 入参增加 `metadata?: Record<string, unknown>`。
4. 在 `ipc-worker.ts` 构造 chat payload 时写入 `metadata: input.metadata`。
5. 在 `apps/agent-runtime/src/types.ts` 的 `ChatTaskInboxRequest` 和 `ContainerInput` 增加 `metadata?: unknown`。
6. 在 `apps/agent-runtime/src/daemon.ts` 调 `executeContainerInput()` 时传入 `metadata: request.metadata`。
7. 在 `apps/agent-runtime/src/daemon.ts` 构造成功和错误 `OutboxResponse.metadata` 时合并请求 metadata：

```ts
metadata: {
  ...(request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
    ? request.metadata
    : {}),
  kind: 'final',
  turn_complete: true,
}
```

8. outbox `buildFinalMetadata()` 已合并 `payload.metadata`，不需要为报告写特殊分支。

报告章节传入的 `responseMetadata`：

```ts
{
  workflow: 'paid_report',
  report_order_id: order.id,
  report_order_no: order.order_no,
  chapter_index: chapterIndex,
  chapter_key: chapter.key,
  chapter_title: chapter.title,
}
```

普通聊天不传 `responseMetadata`，行为保持不变。

### 7.2 类型与校验

内部类型：

- `ReportPreparedInput`
- `ReportPresetSnapshot`
- `ReportChapterSnapshot`

校验：

- preset 必须 enabled。
- `focus.trim()` 必填，最长 300 字。
- `paipan_input` 必须是 object。
- MVP 前端只发八字字段，但后端不要写死八字；后端用 preset 的 `paipan_skill` 调 `executeDirectPaipan()`。
- `chapters` 必须每项有非空 `key/title/prompt_template`。

### 7.3 `previewReport`

签名：

```ts
export async function previewReport(input: {
  userId?: string;
  presetId: string;
  paipanInput: Record<string, unknown>;
  focus: string;
}): Promise<ServiceResult<ReportPreviewResponseDto>>;
```

流程：

1. 读取 preset；不存在或 disabled 返回 404。
2. 合并 `preset.paipan_input_defaults` 和 `paipanInput`。
3. 调 `executeDirectPaipan({ accountId, userId, skillDir: preset.paipan_skill, input: mergedInput })`。登录用户的 `accountId` 用 `getWebChatRuntimeId(userId)`；游客使用固定预览键 `web:report-preview`，因为当前 `executeDirectPaipan()` 只 `void accountId`。
4. 返回 public preset、`skill_context_entry`、章节标题/summary、`preview_hook`。

预览不写订单，不扣费，不创建会话。MVP 先不新增成功请求限流；实现者需确认当前排盘是 API 本地确定性计算，不调用模型、不产生钱包成本。若后续开放高成本排盘，再补 IP/用户限流。

### 7.4 `startReportForOwnedUser`

签名：

```ts
export async function startReportForOwnedUser(input: {
  userId: string;
  presetId: string;
  paipanInput: Record<string, unknown>;
  focus: string;
  entrySource: ReportEntrySourceDto;
}): Promise<ServiceResult<ReportStartResponseDto>>;
```

流程：

1. 读取 preset 并校验 enabled。
2. 合并排盘输入，在事务外调用 `executeDirectPaipan()`。
3. 构造 `presetSnapshot`，包含购买时所有会影响生成的字段。
4. 调 `purchaseReportWithWallet()`，`prepared.metadata` 至少写：

```ts
{
  entry_source: input.entrySource,
  purchased_preset_id: preset.id,
  purchased_preset_badge: preset.badge ?? null,
}
```

5. 异步调用 `enqueueReportChapter({ orderNo, chapterIndex: 0 })`。
6. 如果首章入队失败，必须调用 `refundReportOrder()`，并写入会话失败提示消息。
7. HTTP 返回购买成功信息；首章生成靠 WebSocket/轮询显示。

余额不足映射为 402。

### 7.5 `enqueueReportChapter`

签名：

```ts
export async function enqueueReportChapter(input: {
  orderNo: string;
  chapterIndex: number;
}): Promise<ServiceResult<{ accepted: true }>>;
```

流程：

1. 读取订单；必须 `status === 'generating'`。
2. 从 `preset_snapshot.chapters[chapterIndex]` 取章节。
3. 确定 `userMessageId = rpt-${order.id}-ch${chapterIndex}`。
4. 调 `markReportChapterInFlight()`；返回 null 则认为已有并发处理，返回 ok。
5. 解析章节模型 runtime：复用 `resolveSimpleWorkflowLlmRuntime(userId, model_policy)` 或抽通用 helper；然后 override `billingMode:'none'`。
6. 渲染 `runtimeUserMessageOverride`：
   - 用模板变量替换。
   - `{{focus}}` 从 `preset_snapshot.request.focus` 读取，不从当前 preset 读取。
   - `{{board_title}}` 从 `preset_snapshot.request.board_title` 或 `board_result` message 标题读取。
   - 追加固定约束：这是付费报告章节；请输出完整章节；不要提及 token/计费；禁止恐吓；必要免责声明自然融入。
7. 调 `sendOwnedChatSessionMessage()`：
   - `content`: `生成《{preset_name}》第 {n} 章：{chapter.title}`
   - `inputKind`: `normal`
   - `selectedBoardMessageId`: `order.board_message_id`
   - options:
     - `userMessageId`
     - `llmRuntimeOverride: { ...runtime, billingMode: 'none' }`
     - `runtimeUserMessageOverride`
     - `authorizedSkillBundleIds`
     - `authorizedWorkflowSkillIds`
     - `professionalAiQuotaBypass: 'report_chapter'`
     - `responseMetadata` 为本章报告 metadata
   - 必须走 `sendOwnedChatSessionMessage()` 的正常入队路径，让 Redis `session:processing:{sessionId}` 锁和 `/messages` 的 `processing` 字段保持可用；不要直接调用 runtime 绕开 chat-session-service。
8. 如果 `sendResult.ok === false`：
   - 若 `sendResult.statusCode === 409` 且错误是确定性 `userMessageId` 已存在，视为章节已经在途或已处理，返回 ok，不退款。
   - `refundReportOrder({ reason: sendResult.error })`
   - 写失败退款提示消息。
   - 返回 fail。

入队失败不能让订单停在 `generating`。

### 7.6 `maybeAdvanceReportChapter`

outbox 成功/错误路径调用。

签名：

```ts
export async function maybeAdvanceReportChapter(input: {
  sessionId?: string;
  userMessageId?: string;
  status: 'success' | 'error';
  reason?: string;
}): Promise<void>;
```

流程：

1. sessionId 或 userMessageId 缺失则 return。
2. 根据 `sessionId` 查 `report_orders`。
3. 不存在或不是 `generating` return。
4. 若 `order.current_user_message_id !== userMessageId` return。
5. 若 status 为 `error`：
   - `refundReportOrder({ orderNo, reason })`
   - 写会话失败退款提示。
   - return。
6. success：
   - `advanceReportOrderChapter({ expectedChaptersDone: order.chapters_done, userMessageId })`
   - 0 行 return。
   - 若 `advanceReportOrderChapter()` 返回的最新订单 `chapters_done >= chapters_total`：
     - `completeReportOrder(orderNo)`
     - 写完成提示消息。
   - 否则：
     - `enqueueReportChapter({ orderNo, chapterIndex: next.chapters_done })`
     - 如果入队失败，`enqueueReportChapter` 内部已退款。

### 7.7 状态提示消息

新增内部 helper：

- `storeReportSystemMessage({ order, kind, content })`

失败提示：

```text
报告生成中断，系统已全额退回本次支付金额。
原因：{publicReason}
你仍可以在当前会话中查看已生成的盘面和章节。
```

完成提示：

```text
《{preset_name}》已全部生成完成。
```

metadata：

```json
{
  "kind": "final",
  "workflow": "paid_report",
  "report_order_id": "...",
  "report_order_no": "...",
  "report_status": "refunded"
}
```

### 7.8 恢复/补偿

新增 worker 或服务函数：

- `reconcileStaleReportOrders()`

MVP 最小要求：实现函数和测试，可由 Admin API 手动触发；定时 worker 可选。

规则：

- 扫描 `status='generating' AND updated_at < NOW() - INTERVAL '35 minutes'`。
- 如果 `current_user_message_id` 对应 `_reply` final 消息已存在，调用 `maybeAdvanceReportChapter(success)`。
- 如果 `_error` 消息存在，调用 `maybeAdvanceReportChapter(error)`。
- 如果没有 final/error，退款并写失败提示，原因 `报告生成超时`。

---

## 8. Outbox 接入设计

### 8.1 回调注册

修改 `apps/api/src/runtime/ipc-ai-chat-outbox-handler.ts`：

```ts
export type ReportChapterAdvancer = (input: {
  sessionId?: string;
  userMessageId?: string;
  status: 'success' | 'error';
  reason?: string;
}) => Promise<void>;

let reportChapterAdvancer: ReportChapterAdvancer | null = null;

export function registerReportChapterAdvancer(fn: ReportChapterAdvancer): void {
  reportChapterAdvancer = fn;
}
```

新增内部 helper：

```ts
async function notifyReportChapterAdvancer(input: Parameters<ReportChapterAdvancer>[0]) {
  if (!reportChapterAdvancer) return;
  await reportChapterAdvancer(input).catch((err) => {
    logger.error({ err, sessionId: input.sessionId, userMessageId: input.userMessageId }, '付费报告章节推进失败');
  });
}
```

### 8.2 成功路径

在 `processAiChatResponse()` 成功路径中，`releaseCompletedAiChatSessionLock()` 之后、publish stream 前后均可。推荐放在 release lock 之后、publish 前：

```ts
await notifyReportChapterAdvancer({
  sessionId,
  userMessageId: resolveAiChatFinalUserMessageId(pending, payloadForUsage),
  status: payloadForUsage.status === 'error' ? 'error' : 'success',
  reason: payloadForUsage.error || payloadForUsage.publicErrorText,
});
```

注意：`payload.status === 'error'` 在当前函数不一定进入 catch，它会落库 error message，所以成功路径也必须处理 status error。

### 8.3 catch 路径

catch 中释放锁后也调用：

```ts
await notifyReportChapterAdvancer({
  sessionId: resolveAiChatFinalSessionId(pending, payload),
  userMessageId: resolveAiChatFinalUserMessageId(pending, payload),
  status: 'error',
  reason: errorMsg,
});
```

### 8.4 注册位置

在 `apps/api/src/app/index.ts` 中：

```ts
import { registerReportChapterAdvancer } from '../runtime/ipc-ai-chat-outbox-handler.js';
import { maybeAdvanceReportChapter } from '../modules/chat/report-service.js';
```

在 `main()` 初始化 DB/Redis 后、`startIpcWorker()` 前注册：

```ts
registerReportChapterAdvancer(maybeAdvanceReportChapter);
```

不要让 `ipc-ai-chat-outbox-handler.ts` 直接 import `report-service.ts`。

---

## 9. HTTP API 设计

### 9.1 用户路由

新增：

- `apps/api/src/interfaces/http/report-routes.ts`
- `server.ts` 注册 `await app.register(reportRoutes, { prefix: '/api/reports' })`

接口：

| Method | Path | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/catalog` | 公开 | 返回 enabled presets |
| POST | `/preview` | 可选 | 执行真实排盘预览，不扣费 |
| POST | `/purchase` | 登录 | 扣费并启动报告 |
| GET | `/orders` | 登录 | 当前用户订单列表 |
| GET | `/orders/:orderNo` | 登录 + owner | 查询订单 |

Fastify 路由层保持薄，只做 body 基础校验和 auth 调用。

`GET /orders` query：

- `limit`: 可选，默认 20，最大 50。
- `offset`: 可选，默认 0。

响应可以是最小结构：

```ts
{
  orders: ReportOrderDto[];
}
```

排序：`created_at DESC`。用户端只返回当前用户订单，不返回其他用户订单。

### 9.2 可选鉴权

`/preview` 可不登录。若要读取用户身份，只能使用已有 JWT 校验逻辑的非强制版本；如果现有代码没有 `resolveOptionalUserId`，MVP 可直接按游客预览执行，不读取 userId。

### 9.3 Purchase 校验

`POST /purchase` body：

- `preset_id`: string，必填。
- `paipan_input`: object，必填。
- `focus`: string，trim 后 1-300 字。
- `entry_source`: 可选，白名单：`sidebar`、`dashboard`、`ai_chat_empty`、`ai_chat_report_done`、`wallet_return`、`direct`。

路由层必须把未知 `entry_source` normalize 为 `direct`，不要原样入库。

八字 MVP 的 `paipan_input` 基础校验：

- `solarDate`: `YYYY-MM-DD`，必填。
- `hour`: 0-23 整数。
- `minute`: 0-59 整数。
- `gender`: `男` 或 `女`。

后端仍按 preset 的 `paipan_skill` 调排盘，不要把服务层写死只能八字；这里只是 MVP seed preset 的输入保护。

`POST /preview` 使用同一套 `preset_id`、`paipan_input`、`focus` 校验；preview 不接受 `entry_source`。

### 9.4 充值回跳安全

报告页余额不足会把用户送到 `/wallet?return_to=...`。钱包充值链路需要保存并返回 `return_to`，但必须复用前端/后端同等语义的站内路径校验：

- 只接受以 `/` 开头的站内路径。
- 拒绝 `//example.com`。
- 拒绝 `/login` 和 `/login?...`，避免登录回环。
- 拒绝外部完整 URL。
- 非法值保存为 `null`。

API 不需要把 `return_to` 传给支付平台；支付平台仍回到固定 `/wallet/recharge/result`，结果页再根据订单 DTO 的 `return_to` 显示返回按钮。

钱包页可读取 query `amount` 作为充值金额初始值：

- `amount` 必须是正数，最多 2 位小数。
- 若 `amount` 小于支付配置最小值或非法，回退到钱包现有默认金额。
- `amount` 不写入报告订单，只用于减少余额不足后的充值摩擦。

### 9.5 错误响应

- 400：参数错误。
- 401：购买/订单查询未登录。
- 402：余额不足。
- 403：订单不属于当前用户。
- 404：preset/order 不存在。
- 500：未知错误。

402 响应尽量包含：

```ts
{
  error: string;
  required_coins?: number;
  available_coins?: number;
}
```

### 9.6 Admin API（MVP 后端保留，前端可不做）

在 `apps/api/src/interfaces/http/admin-routes.ts` 增加：

- `GET /reports/presets`
- `PATCH /reports/presets/:id`
- `GET /reports/orders`
- `POST /reports/reconcile`

权限：未列入 `USER_MANAGER_ALLOWED_ROUTES`，默认 `admin:*`。

---

## 10. 前端实现清单

### 10.1 新增文件

- `apps/web/features/reports/api.ts`
- `apps/web/features/reports/hooks/use-report-catalog.ts`
- `apps/web/features/reports/hooks/use-report-order.ts`
- `apps/web/app/reports/page.tsx`
- `apps/web/components/reports/report-workspace.tsx`
- `apps/web/components/reports/report-catalog.tsx`
- `apps/web/components/reports/report-purchase-flow.tsx`
- `apps/web/components/reports/report-preview-panel.tsx`
- `apps/web/components/reports/report-progress-banner.tsx`

### 10.2 API client

`features/reports/api.ts`：

- 从 `@fateclaw/contracts/report` import DTO。
- 使用 `requestJson`，不要散落 fetch。
- 导出 `reportsApi.catalog/preview/purchase/orders/order`。
- 所有请求路径使用 API 前缀：`/api/reports/catalog`、`/api/reports/preview`、`/api/reports/purchase`、`/api/reports/orders`。
- `reportsApi.orders(params?: { limit?: number; offset?: number })` 映射到 `/api/reports/orders?limit=&offset=`。

### 10.3 组件职责

`apps/web/app/reports/page.tsx`：

- 只负责渲染 `<ReportWorkspace />`，不要把页面状态堆在 route 文件里。
- `apps/web` 使用静态导出，不要依赖 Next server runtime；catalog/preview/purchase 都在 client component 里通过 API client 加载。

`ReportWorkspace`：

- 使用 `AppShell wide requireAuth={false}`。
- 读取 search params：`preset_id`、`source`。
- 负责 catalog 加载、默认选中、entrySource normalize、登录/充值/购买跳转。

`ReportCatalog`：

- 只展示商品卡片和选中态。
- 不发 API，不读取 URL。

`ReportPurchaseFlow`：

- 维护表单、预览按钮、购买按钮、余额不足提示。
- 购买前如果没有 preview，先调用 preview。

`ReportPreviewPanel`：

- 展示盘面预览、章节大纲、preview hook。
- 不包含购买状态机。

`ReportProgressBanner`：

- 只根据 `ReportOrderDto` 和当前会话状态展示进度/完成/退款。
- 不直接发起订单轮询；轮询由 hook 或父组件处理。

最近订单：

- `/reports` 登录态下调用 `reportsApi.orders({ limit: 3 })` 或最小实现直接取默认列表后 slice。
- 展示订单名、状态、进度、创建时间、价格。
- 有 `session_id` 时按钮跳 `/ai-chat?sid=<session_id>`。
- 最近订单里如果存在 `generating`，前端每 3-5 秒刷新一次订单列表；全部终态后停止刷新。
- 不做独立报告详情页。

### 10.4 页面状态

`/reports` 页面 state：

- `catalog`
- `selectedPresetId`
- `entrySource`
- `form`
- `preview`
- `previewLoading`
- `purchaseLoading`
- `error`

行为：

- 首次加载 catalog 后优先选 query `preset_id`；没有 query 时默认选 `annual-bazi-deep`；若该 preset 不存在或 disabled，再回退到 sort_order 最小的 preset。
- 读取 query `source`，按白名单 normalize 到 `entrySource`，未知值按 `direct`。
- purchase 请求必须带 `entry_source: entrySource`。
- 切换 preset 清空 preview，但保留用户输入。
- 预览按钮 loading 时禁用。
- 购买必须先有成功 preview；如果没有 preview，点击购买先自动预览，再购买。
- 选中低价款且 catalog 中存在 `annual-bazi-deep` 时，购买 CTA 附近显示次级按钮「升级为流年深度命书」，点击只切换 preset，不打开弹窗。

### 10.5 登录与跳转

- 使用现有 auth hook 判断登录态。
- 未登录点击 CTA 使用 `buildLoginHref(current /reports URL)`，最终 URL 形如 `/login?next=<encoded current /reports URL>`，保留 `preset_id` 和 `source`。
- 购买成功后进入 AI Chat：
  - 必须使用 router push `/ai-chat?sid=<id>`，让现有 hook 从 URL 读取。
  - 如果页面已经在 ChatSessionsProvider 作用域内，可额外刷新/触碰 session 列表，但不能只依赖 provider 内存状态。

### 10.6 体系入口

侧栏入口：

- 在 `apps/web/components/sidebar.tsx` 增加「命书报告」入口，路径 `/reports?source=sidebar`。
- 位置放在归档/新建对话按钮下方、会话列表上方，不能只放底部快捷区。
- 桌面侧栏和移动抽屉都能进入。
- 图标用 lucide-react，例如 `ScrollText` 或 `BookOpenText`。
- active 条件使用 `pathname === '/reports'`。

Dashboard 入口：

- 修改 `apps/web/components/dashboard/workspace-dashboard.tsx`，在现有微信连接模块之前增加 `reports-entry` section。
- 入口指向 `/reports?source=dashboard`。
- 保持工作台风格：小标题、短说明、一个主按钮，不做营销大图。
- 推荐文案：标题 `命书报告`，说明 `先看盘面预览，再解锁完整章节报告`，按钮 `生成命书报告`。
- 该入口应该复用现有 `DashboardSection` 外观，避免引入另一套营销样式。

AI Chat 入口：

- 修改 `apps/web/components/ai-chat/ai-chat-workspace.tsx` 的 `HomeModeSelector`，在现有「快速开始」「专业排盘」旁增加第三张「命书报告」入口卡。
- 入口指向 `/reports?source=ai_chat_empty`。
- 入口卡不受 `expertModeLocked` 限制；未登录用户也可进入报告页看免费预览，购买时再登录。
- `HomeModeSelector` 当前是 `sm:grid-cols-2`，需要改成能容纳三张卡的响应式布局，例如 `sm:grid-cols-3` 或桌面三列、移动单列。
- 不要在已有消息列表中强插广告；仅在首页模式选择区展示。
- 在非报告会话的回答完成轻提示附近，可以增加一个文本级入口 `生成完整命书报告`，指向 `/reports?source=ai_chat_report_done`；该入口只在没有正在生成、没有选中报告订单时显示。

充值回跳：

- 余额不足按钮跳 `/wallet?return_to=<encoded /reports?preset_id=<id>&source=wallet_return>&amount=<max(required-available, 0)>`。
- `amount` 使用 402 响应的 `required_coins - available_coins`，按 2 位小数向上取整，最低不低于支付配置最小充值额。
- 从钱包返回后，`/reports` 必须恢复对应 preset。
- 钱包页需要补最小回跳能力：
  - `apps/web/components/settings/wallet/wallet-workspace.tsx` 读取 query `return_to` 和 `amount`，用 `normalizeReturnTo()` 校验后传给 `TabWallet` / `WalletRechargePanel`。
  - `WalletRechargePanel` 增加 `initialAmountCoins?: string | number`，合法时初始化 `amountCoins`。
  - `apps/web/features/billing/api.ts` 的 `createRechargeOrder()` 接收可选 `return_to`。
  - `apps/api/src/interfaces/http/billing-routes.ts` 读取 body `return_to`，传给 `createRechargeOrderForUser()`。
  - `apps/api/src/modules/billing/recharge-service.ts` 用安全站内路径校验后写入充值订单 metadata：`return_to`。
  - `packages/contracts/src/billing/index.d.ts` 给 `RechargeOrderDto` 增加 `return_to?: string | null`，`toRechargeOrderDto()` 只暴露这个字段，不暴露完整 metadata。
  - `apps/web/components/settings/wallet/recharge-result/recharge-result-workspace.tsx` 在 paid 状态下优先显示「返回命书报告」按钮，href 使用 `order.return_to`；没有 return_to 时保持回 `/wallet`。

### 10.7 钱包流水展示

修改 `apps/web/components/settings/wallet/wallet-transaction-labels.ts`：

- `kind === 'report_purchase'` 且 `amount_coins < 0` 时显示 `pages.wallet.badgeReportPurchase`。
- `kind === 'report_refund'` 且 `amount_coins > 0` 时显示 `pages.wallet.badgeReportRefund`。
- 不改变现有 `overage_charge` 隐藏规则；报告购买/退款必须可见。

### 10.8 Chat 进度

在 `apps/web/components/ai-chat/ai-chat-workspace.tsx`：

- 根据当前 session messages 推断 `report_order_no`。
- 若能拿到 orderNo，调用 `useReportOrder(orderNo)`。
- 在消息区上方渲染 `ReportProgressBanner`。
- 没有 orderNo 时不渲染。
- 购买跳转到 `/ai-chat?sid=<id>` 后，现有 `useChatMessages` 会读取 messages 接口里的 `processing` 状态并轮询；如果实测后台报告章节已入队但 `processing` 没有置 true，需要在报告入队路径复用现有会话 processing 标记或补一次前端轻量轮询，直到订单 `completed/refunded`。
- 不要求本次新增独立报告 WebSocket；优先复用 AI Chat 当前 stream ticket 和 messages polling。
- completed 状态下：
  - 显示 `继续追问本报告`，保持在当前会话，不跳转。
  - 显示 `开通会员获得日常解读额度`，链接 `/membership`。
  - 如果订单 preset 是 `solar-term-bazi-brief`，额外显示 `解锁流年深度命书`，链接 `/reports?preset_id=annual-bazi-deep&source=ai_chat_report_done`。

### 10.9 章节徽标

在消息展示工具中增加 helper：

```ts
export function getReportChapterLabel(metadata?: MessageMetadataDto | null): string | null
```

当 metadata 是付费报告章节，返回 `第 N 章 · 标题`。

---

## 11. 安全、并发、幂等

### 11.1 不二次扣费

章节调用必须使用：

```ts
llmRuntimeOverride: {
  ...resolvedRuntime,
  billingMode: 'none',
}
```

验收时检查：

- `wallet_transactions` 有 `report_purchase`。
- 没有因该章节 requestId 产生的 `model_charge` / `overage_charge` 等 token 扣费流水。
- conversation log 仍可记录 token usage，这不等于钱包扣费。

### 11.2 会话串行

现有 `session:processing:{sessionId}` Redis 锁保证同一会话只处理一轮。章节推进必须在前章释放锁后再 enqueue 下一章。

### 11.3 章节幂等

三层保护：

1. `userMessageId = rpt-${order.id}-ch${index}` 确定性。
2. `sendOwnedChatSessionMessage()` 重复 userMessageId 返回 409。
3. `advanceReportOrderChapter()` 用 `chapters_done + current_user_message_id` CAS。

### 11.4 订单幂等

- 购买幂等：MVP 不做客户端幂等键；前端按钮禁用防重复点击。
- 退款幂等：`SELECT ... FOR UPDATE` 后 `status==='refunded'` 直接返回。
- 完成幂等：`completeReportOrder()` 只允许 `status='generating' AND chapters_done=chapters_total`。

### 11.5 恢复

实现 `reconcileStaleReportOrders()`，防止服务重启后订单永久卡住。

---

## 12. 测试计划

### 12.1 API/仓储测试

新增或修改测试：

- `apps/api/tests/infrastructure/repositories/report-repository.test.ts`
- `apps/api/tests/modules/chat/report-service.test.ts`
- `apps/api/tests/interfaces/http/report-routes.test.ts`
- `apps/api/tests/runtime/ipc-ai-chat-outbox-handler.test.ts` 或现有 outbox 测试中补注册回调断言。

必须覆盖：

1. `purchaseReportWithWallet` 足额购买：扣 bonus/purchased，创建订单/会话/盘面消息/流水。
2. 余额不足：返回 402，不创建订单。
3. `refundReportOrder`：原路退两桶，重复调用只退一次。
4. `enqueueReportChapter`：传入 `billingMode:'none'` 和 `professionalAiQuotaBypass:'report_chapter'`。
5. 入队失败：订单 refunded，写失败消息。
6. `maybeAdvanceReportChapter` success：CAS +1，触发下一章。
7. 重放同一 final response：CAS 0 行，不重复推进。
8. 最后一章 success：订单 completed。
9. final error：订单 refunded。
10. outbox `payload.status === 'error'` 但未 throw 时仍通知 error。
11. purchase 写入 `report_orders.metadata.entry_source`，钱包流水 metadata 同步写入 `entrySource`。
12. 充值订单只保存通过站内路径校验的 `return_to`；外部 URL 或 `//evil.test` 被丢弃。
13. `report_orders.metadata` 和 `wallet_transactions.metadata` 不包含 `paipan_input`、出生日期、出生时间、性别等敏感排盘输入。

### 12.2 前端测试

新增：

- `apps/web/tests/features/reports/api.test.ts`
- 组件测试：`apps/web/tests/components/reports/report-progress-banner.test.tsx`

覆盖：

- API path 和 method 正确。
- 402 错误能被购买流显示为余额不足。
- metadata 能格式化章节徽标。
- `/reports?preset_id=annual-bazi-deep&source=dashboard` 能默认选中主力款并把 `entry_source` 传给 purchase。
- 低价款选中时显示升级主力款按钮。
- 未登录购买使用 `/login?next=...`，不是 `/login?return_to=...`。
- 钱包结果页 paid 状态下，存在安全 `return_to` 时显示返回报告页按钮；没有时仍返回 `/wallet`。
- `/wallet?amount=87.5&return_to=...` 能把充值金额预填为 `87.5`；非法 amount 回退默认值。
- `/reports` 公开访问时仍显示备案页脚。

### 12.3 验证命令

实现完成后至少运行：

```bash
pnpm run typecheck
pnpm test apps/api/tests/infrastructure/repositories/report-repository.test.ts apps/api/tests/modules/chat/report-service.test.ts apps/api/tests/interfaces/http/report-routes.test.ts apps/web/tests/features/reports/api.test.ts
pnpm run lint
```

如改动前端 UI 较多，再运行：

```bash
pnpm --filter fateclaw-web build
```

### 12.4 手工端到端验收

1. 游客访问 `/reports`，选择流年深度命书，填生日信息，能看到真实盘面预览、章节大纲、首章钩子，不产生 wallet transaction。
2. 未登录点击 CTA，跳登录。
3. 登录且余额不足点击购买，接口 402，前端显示去充值。
4. 登录且余额足够购买，扣 99，跳 AI Chat，章节从第 1 章开始逐章生成。
5. 订单完成后 `report_orders.status='completed'`，`chapters_done=chapters_total`。
6. 钱包流水只有一笔 `report_purchase`，无 token 二次扣费流水。
7. 人为让第 2 章 prompt 报错或 mock provider error，订单 `refunded`，钱包出现一笔 `report_refund`，余额回到购买前。
8. 重放同一 final response，不增加 `chapters_done`。
9. 修改 seed preset 章节后，已创建订单继续按 `preset_snapshot` 生成。
10. 侧边栏点击「命书报告」进入 `/reports?source=sidebar`，Dashboard 入口进入 `/reports?source=dashboard`，AI Chat 空态入口进入 `/reports?source=ai_chat_empty`。
11. 从 `/reports?preset_id=solar-term-bazi-brief` 选低价款预览后，能一键切换到 `annual-bazi-deep`。
12. 购买后 `report_orders.metadata.entry_source` 与入口来源一致，可用 SQL 按来源统计订单数和平均 `price_coins`。
13. 余额不足从报告页去充值，钱包页预填缺口金额，支付成功结果页能返回原报告 preset。
14. 数据库检查：报告订单 metadata 和钱包流水 metadata 中没有出生日期/时间/性别；报告章节仍能通过 `preset_snapshot.request.focus` 正常生成。
15. 非报告会话回答完成后，轻量入口进入 `/reports?source=ai_chat_report_done`，不会插入广告消息。

---

## 13. 实施顺序

按以下顺序执行，不要先做 UI 再补状态机：

1. Contracts：新增 report DTO，扩 chat metadata。
2. DB：新增 migration、seed、db.ts export。
3. Chat repository：增加 `Using(client)` 事务 helper。
4. Report repository：preset/order/购买/退款/CAS。
5. Report service：preview、purchase、enqueue、advance、reconcile。
6. Outbox：回调注册与成功/error 通知。
7. HTTP routes：`/api/reports` + server 注册。
8. 单元测试补齐后跑 API 相关测试。
9. Web API client + `/reports` 页面 + components，包含默认主力款、URL preset/source、登录/充值回跳。
10. 体系入口：侧栏固定入口、Dashboard 入口卡、AI Chat 空态入口。
11. AI Chat 进度 banner、章节徽标和完成态升级/会员链接。
12. 全量 typecheck/lint/test。
13. 手工端到端验收。

### 13.1 最终勾选表

实现完成前逐项确认：

- `/reports` 可公开访问、可预览、购买时要求登录。
- `/reports` 使用 `AppShell wide requireAuth={false}`，且显示合规备案页脚。
- 侧边栏、Dashboard、AI Chat 首页、非报告回答完成后轻量入口都存在，并携带不同 `source`。
- 默认选中 `annual-bazi-deep`，低价款能一键升级到主力款。
- 只有 URL 显式 `preset_id=solar-term-bazi-brief` 或用户点击低价卡时才选中低价款。
- 余额不足能进入钱包，支付成功结果页能返回原报告 preset。
- 钱包页能用报告缺口金额预填充值金额。
- `report_orders.metadata.entry_source` 和钱包流水 metadata 能区分入口来源。
- 订单 metadata 和钱包流水 metadata 不包含出生日期、出生时间、性别、完整排盘输入。
- 购买只产生 `report_purchase`，章节生成不产生 token 钱包扣费。
- 失败只进入 `refunded`，不会停在 `generating`。
- 完成态 AI Chat banner 提供继续追问、会员承接、低价款升级主力款入口。

---

## 14. 实现注意事项

- 不要在 agent-runtime 中实现报告逻辑；报告编排属于 API host。
- 不要修改普通 AI Chat 计费语义；只对报告章节 turn override `billingMode:'none'`。
- 不要把 `report_order_id` 依赖于 IPC response metadata；DB 是唯一真相。
- 不要在章节失败时保留 `generating` 状态。
- 不要把 `wallet_transactions.request_id` 当唯一约束。
- 不要主动删除或重构现有 simple workflow 代码。
- 不要把报告正文另存一份到 `report_orders`；正文以 messages 为准，订单只存进度和快照。
- 不要把出生日期、出生时间、性别等排盘输入写入订单 metadata 或钱包流水 metadata。
- 不要用弹窗、倒计时、恐吓文案提高客单；MVP 的高客单策略只靠默认主力款、低价款升级入口、完成态会员/主力款承接。
- `/reports` 公开可访问，记得把 AppShell 合规页脚展示范围扩到 `/reports`。
- 新增公开函数、类、接口必须有中文 doc comment；复杂状态机和退款取舍必须有中文注释。

---

## 15. 阶段 2（不阻塞 MVP）

这些不属于本次一次性 MVP 的验收范围：

- Admin 前端报告 preset 编辑页。
- 报告 PDF/Word 导出。
- 报告分享页。
- 客户端购买幂等键。
- 更严谨的 bonus grant 退款重建。
- 泛化 7 套排盘表单 UI。
- 报告生成成本统计与毛利面板。
