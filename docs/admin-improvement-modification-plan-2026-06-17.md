# Admin 管理后台完善修改文档

日期：2026-06-17

对象：`apps/admin` 独立管理后台，以及它依赖的 `apps/api/src/interfaces/http/admin-routes.ts` 管理端接口契约。

用途：本文档给后续 AI 或开发者直接执行修改使用。执行方应先读取本文，再读取相关源码和项目脚本，不要跳过探索阶段直接改代码。

## 执行摘要

本任务属于现有后台中等风险改造。执行方应先读取本文、`apps/admin/AGENT.md`、`apps/admin/package.json`、根 `package.json` 和相关源码，再按 P0 到 P2 的顺序实现。

执行原则：

- 先完成权限与安全 P0，再补已有接口入口 P1，最后做共享后台体验 P1/P2。
- 不启动或重启本地 API 服务，不运行 API dev/server 命令，直接使用用户已经启动好的 API。
- 如需要本地交互验证，只按需启动 admin 前端。
- 不做截图、录屏、图片比对或其他可视产物，记录文字版操作结果和命令输出摘要即可。
- 不改变公开用户站路由、数据库 schema、生产密钥配置、支付回调契约、现有公告和收支公开 API 行为。
- 不扩大 user_manager 权限，不把管理密钥写入前端环境变量或静态文件，不做无关视觉重设计。
- 优先修改 `apps/admin`、`apps/api/src/interfaces/http/admin-routes.ts`、`apps/admin/tests` 和直接相关的 contracts 或 API 类型。
- 不修改 `apps/web`、`apps/agent-runtime`、部署包、压缩包或无关文档。

完成标准：

- 所有 P0 和 P1 必做项已完成。
- TypeScript、构建和相关测试通过。
- owner 和 user_manager 的文字版验证结果齐全。
- 文档中的验收标准逐项满足。
- 未完成的 P2 项被明确列为后续任务。

暂停条件：

- 需要真实生产密钥、生产数据、真实支付操作、删除真实用户数据或数据库迁移。
- 用户明确要求改动本文档列为“暂不纳入本轮”的能力。
- user_manager 可创建角色策略需要从默认方案 A 改为方案 B。

## 执行前默认策略和环境要求

执行方按本节默认策略推进，不需要在开始前反复询问。只有要偏离默认策略时才向用户确认。

### 1. user_manager 可创建的用户角色白名单

**背景：** user_manager 有 `users:create` scope，但不应随意创建高权限用户角色。

**可选方案：**

- **方案 A（推荐，最安全）：** 仅允许创建 `consumer` 角色
  - 理由：consumer 是最低权限用户，适合客服或运营团队日常创建测试账号或协助用户注册
  
- **方案 B（适度放开）：** 允许创建 `consumer`、`creator` 和 `both` 角色
  - 理由：如果运营团队需要为合作创作者开通账号，可以放开 creator 和 both
  - 风险：creator 和 both 用户在产品中可能有额外权限（如发布内容、创建知识库等）

- **方案 C（禁止，必须坚持）：** 禁止创建 `admin` 角色
  - 理由：admin 角色用户在系统中可能有特殊权限，只有 owner 可创建

**默认执行方案 A，除非用户明确选择方案 B。方案 C 是强制约束，必须在后端实现。**

### 2. 测试环境准备

确认本地环境已准备：

- owner 管理密钥（用于验证完整权限）
- user_manager 管理密钥（用于验证受限权限）
- API 服务已启动且可访问（执行过程中不重启）
- 至少一个测试用户账号（用于查看用户详情、赠送余额批次等功能）

### 3. 术语约定

为避免混淆，本文档统一使用以下术语：

- **系统用户角色**：存储在 users 表的 role 字段，包括 `consumer`、`creator`、`both`、`admin`
- **管理员身份**：管理密钥对应的 principal.role，包括 `owner` 和 `user_manager`
- **管理员权限作用域**：principal.scopes 中的具体权限标识，如 `admin:*`、`users:read`、`users:create`、`messages:read`

## 总体目标

把 admin 从“能用的功能集合”整理成“可长期运营的管理台”。

最终状态应满足：

- owner 能看到和操作所有后台能力。
- user_manager 只能看到自己有 scope 的页面和操作，不能看到会必然 403 的危险按钮。
- 前端 `AdminScope` 与后端真实 scope 一致。
- 用户详情能查看赠送余额批次、过期、耗尽和来源。
- 账单页能对陈旧计费预留执行安全的手动 reconcile。
- 系统配置变更有可见审计信息。
- 关键筛选、分页、错误、确认弹窗和 loading 样式更统一。
- 大页面拆出可维护组件，避免继续扩大单文件复杂度。

## 当前证据摘要

现有 admin 已覆盖以下模块：

- `/overview` 总览、充值收入、Token 和模型选择分布。
- `/status` 运行状态、处理会话、7 日 Token 遥测。
- `/billing` 充值订单、余额流水、计费预约。
- `/users` 用户创建、详情、余额、会员、密码、账号、日志清理、删除。
- `/messages` 网页会话查看、Pi session 文件维护。
- `/logs` 对话日志查看、request_id 搜索、用户日志清理。
- `/skills` 系统排盘开关、用户知识技能列表和详情。
- `/workflows` 简易 workflow preset 配置。
- `/system/models` 官方模型、密钥、Token 单价、运行时策略。
- `/system/rewards` 充值配置和软妹币奖励配置。
- `/gifts` 礼品码生成和列表。
- `/announcements` 公告管理。
- `/about` 关于页收支流水。
- `/referrals` 邀请配置和邀请关系列表。

关键文件线索：

- `apps/admin/lib/admin-navigation.ts` 的 `canAdminRoleAccessPath` 只按 role 判断。
- `apps/admin/components/admin-sidebar.tsx` 的 `navItems` 只按 role 控制可见性。
- `apps/admin/lib/admin-api.ts` 的 `AdminScope` 定义为 `admin:*`、`users:*`、`messages:*`，但后端真实返回 `admin:*`、`users:read`、`users:create`、`messages:read`。
- `apps/api/src/interfaces/http/admin-routes.ts` 已经在 `USER_MANAGER_ALLOWED_ROUTES` 中给 user_manager 开放 `POST /users`。
- `apps/admin/app/(dashboard)/users/page.tsx` 的创建用户表单允许选择 `admin` 用户角色。
- `apps/api/src/interfaces/http/admin-routes.ts` 已有 `GET /users/:id/balance/grants`，但前端没有对应 admin-api 方法和页面入口。
- `apps/api/src/interfaces/http/admin-routes.ts` 已有 `POST /billing/reconcile`，但前端没有对应 admin-api 方法和账单页操作入口。
- `apps/admin/lib/admin-api.ts` 的 `AdminSystemConfigOverview` 包含 `audit_logs`，但 `apps/admin/app/(dashboard)/system/models/page.tsx` 没有展示。
- `apps/admin/app/(dashboard)/users/page.tsx` 超过 1400 行，`messages`、`billing`、`announcements`、`workflows` 也偏大，应拆分。

## 修改范围

允许修改：

- `apps/admin/lib/admin-api.ts`
- `apps/admin/lib/admin-navigation.ts`
- `apps/admin/components/admin-sidebar.tsx`
- `apps/admin/app/(dashboard)/layout.tsx`
- `apps/admin/app/(dashboard)/users/page.tsx`
- `apps/admin/app/(dashboard)/billing/page.tsx`
- `apps/admin/app/(dashboard)/system/models/page.tsx`
- `apps/admin/app/(dashboard)/messages/page.tsx`
- `apps/admin/app/(dashboard)/logs/page.tsx`
- `apps/admin/components/ui`
- `apps/admin/components` 下新建后台通用组件
- `apps/admin/tests`
- `apps/api/src/interfaces/http/admin-routes.ts`
- 必要时修改 `packages/contracts` 中与 admin DTO 直接相关的类型
- 必要时增加或调整 `apps/api/tests` 中 admin 权限测试

默认不要修改：

- `apps/web`
- `apps/agent-runtime`
- 数据库 migration
- docker、部署、打包脚本
- 已生成的 tar.gz 包
- 与 admin 无关的 README 或公开文案

## P0 任务一：权限和 scope 闭环

### 问题

后端已经有 scope 化权限，但前端只按 role 控制页面和菜单。结果是 user_manager 可以进入用户页，却会看到大量 owner 才能执行的操作。更严重的是，user_manager 后端允许 `POST /users`，而前端创建用户时允许选择 `admin` 系统用户角色，存在权限语义风险。

### 实现要求

1. 修正前端 `AdminScope` 类型。
   - 改为包含 `admin:*`、`users:read`、`users:create`、`messages:read`。
   - 不再使用不存在的 `users:*` 和 `messages:*`。

2. 增加统一权限判断 helper。
   - 建议在 `apps/admin/lib/admin-navigation.ts` 或新文件中提供 `hasAdminScope`。
   - `admin:*` 可通过所有检查。
   - 具体 scope 只通过对应能力。

3. 改造导航配置。
   - `navItems` 从 `roles` 改为 `requiredScopes` 或同时支持 role 与 scope，但最终判断必须基于 session.scopes。
   - `AdminSidebar` 接收完整 `AdminSession` 或至少接收 `scopes`。
   - owner 看到全部 owner 菜单。
   - user_manager 只看到用户和消息相关菜单。

4. 改造路由守卫。
   - `canAdminRoleAccessPath` 改成基于 scopes 的 `canAdminSessionAccessPath`。
   - `/users` 需要 `users:read`。
   - `/messages` 需要 `messages:read`。
   - 其它 owner 页面需要 `admin:*`。
   - 403 时不要一律跳转登录页，应显示“无权访问该管理功能”，并提供返回 home_path 的入口。

5. 改造用户页操作可见性。
   - user_manager 可以查看用户列表和用户详情。
   - user_manager 可以创建安全用户角色。默认只允许创建 `consumer`。如果已确认方案 B（见"执行前必须确认的产品策略"），则同时允许 `creator` 和 `both`。
   - user_manager 不应看到或不应可点击余额调整、赠送余额、会员设置、停用会员、重置密码、清空日志、删除用户。
   - owner 保持现有能力。

6. 后端补强创建用户限制。
   - 在 `POST /api/admin/users` 路由中读取 `request.adminPrincipal`。
   - 如果 principal 不是 owner，禁止创建 `admin` 系统用户角色。
   - 根据产品策略决策（方案 A 或 B），进一步限制 user_manager 可创建的角色白名单。
   - 返回 403 和中文错误，不要只依赖前端隐藏。

7. 统一错误处理。
   - `isAdminForbiddenError` 当前只定义未使用，需要在页面和通用请求处理里用起来。
   - 对 403 展示权限错误，而不是显示普通”加载失败”。
   - 参考”错误处理规范”章节统一实现。

### 验收标准

- owner 登录后看到所有菜单和所有操作。
- user_manager 登录后只看到用户、消息入口。
- user_manager 用户详情页不展示 owner 危险操作。
- user_manager 不能通过构造请求创建 `admin` 系统用户角色。
- 403 显示明确权限说明，不误导为登录失效或网络错误。
- `pnpm --filter fateclaw-admin exec tsc --noEmit` 通过。
- `pnpm --filter @fateclaw/api typecheck` 通过。
- 相关测试通过（见"测试计划 - P0 权限闭环测试"）。

## P1 任务二：补齐赠送余额批次查询

### 问题

用户详情页可以发放赠送余额，但看不到赠送余额来自哪些批次、何时过期、是否耗尽。后端已存在 `GET /api/admin/users/:id/balance/grants`。

### 实现要求

1. 在 `apps/admin/lib/admin-api.ts` 增加 DTO。
   - 字段参考后端 `BalanceGrantRow`。
   - 包含 id、user_id、source、granted_by、amount_coins、remaining_coins、note、expires_at、status、created_at、updated_at。

2. 在 `admin` 对象增加方法。
   - 方法名建议 `userBalanceGrants`。
   - 参数包括 user id、include_exhausted、limit。
   - 默认 limit 建议 20。

3. 在用户详情余额区域展示批次。
   - 展示总额、剩余、状态、来源、过期时间、备注。
   - 默认展示未耗尽批次。
   - 提供“显示已耗尽和已过期批次”的轻量开关。
   - 发放赠送余额成功后刷新批次。

4. 状态文案。
   - active 显示“可用”。
   - exhausted 显示“已耗尽”。
   - expired 显示“已过期”。
   - revoked 显示“已撤销”。

### 验收标准

- owner 用户详情页能看到赠送余额批次。
- user_manager 若只有 `users:read`，可以查看批次但不能发放赠送余额。
- 发放赠送余额后，新批次出现在列表。
- 空状态显示“暂无赠送余额批次”。
- API 非 200 时显示中文错误。

## P1 任务三：补齐计费预留 reconcile 操作

### 问题

账单页能看到冻结中和待结算预约，但不能触发后端已有的陈旧预留修复能力。后端已有 `POST /api/admin/billing/reconcile`，返回 released 和 requestIds。

### 实现要求

1. 在 `apps/admin/lib/admin-api.ts` 增加方法。
   - 方法名建议 `reconcileBillingReservations`。
   - 参数包括 stale_ms 和 limit。
   - 返回 released 和 requestIds。

2. 在 `/billing` 页面增加安全操作入口。
   - 位置建议在“计费预约”标题行或筛选区下方。
   - 默认参数使用后端默认，不强迫管理员输入。
   - 可提供高级选项：陈旧分钟数和处理上限。
   - 操作前必须用统一确认弹窗说明会释放陈旧冻结预留。
   - 操作完成后刷新 stats、reservations 和 wallet transactions。

3. 权限。
   - 仅 owner 可见。
   - user_manager 不应看到入口。

4. 结果展示。
   - 成功显示释放数量。
   - 如果 requestIds 数量较少，可折叠展示。
   - 如果 released 为 0，显示“没有需要修复的陈旧预留”。

### 验收标准

- owner 可以手动触发 reconcile。
- 操作前有明确确认。
- 成功后刷新账单数据。
- user_manager 看不到入口。
- 后端错误以中文错误展示。

## P1 任务四：展示系统配置审计日志

### 问题

`AdminSystemConfigOverview` 已返回 `audit_logs`，但模型配置页面没有展示。管理员无法确认最近谁改了模型、价格、运行时策略。

### 实现要求

1. 在 `/system/models` 页面底部增加“配置审计”区域。
   - 展示 action、target_type、target_key、actor_user_id、created_at。
   - before_json 和 after_json 默认折叠。
   - 使用可读的 JSON diff 或并排 JSON 预览，首版可先做折叠 JSON。

2. 增加筛选或分组。
   - 首版至少按 target_type 分组或显示 target_type 标签。
   - 后续可扩展为独立审计页，但本次先不要新增太多路由。

3. 文案。
   - 明确这是“配置变更审计”，不是对话日志。

### 验收标准

- systemConfig 返回 audit_logs 时页面可见。
- 没有日志时显示空状态。
- 展开 JSON 后文本和按钮不溢出容器。
- 不泄漏明文 API key。若 before_json 或 after_json 含敏感字段，前端展示前需要遮蔽 api_key、secret、token、private_key 等字段。

## P1 任务五：统一危险操作确认

### 问题

当前部分页面使用 `window.confirm`，部分页面使用 `useConfirm`，用户页部分危险操作使用二次点击状态。体验不一致，也不利于审计和权限提示。

### 实现要求

1. 保留现有 `ConfirmProvider` 和 `useConfirm`。
2. 把公告、关于收支等页面的 `window.confirm` 改为统一 confirm dialog。
3. 用户页危险操作可以继续二次确认，但建议改为统一 dialog。
4. 对删除用户、清空日志、归档清理、reconcile 等操作，确认文案必须包含影响范围。
5. 高风险操作建议增加 optional reason 字段，但本次不强制后端落库，除非已有审计能力可以承接。

### 验收标准

- admin 页面中不再直接调用 `window.confirm`。
- 危险操作确认文案清晰。
- Esc、取消按钮、遮罩点击行为符合现有 ConfirmProvider 逻辑。
- 键盘焦点不丢失。

## P1 任务六：共享后台壳和状态组件

### 问题

多个页面重复实现标题、刷新、错误、loading、空状态、分页和筛选控件。大页面继续增长会降低维护性。

### 实现要求

优先新增轻量共享组件，不引入新的设计系统依赖。

建议组件及目录结构：

**后台通用组件（放在 `apps/admin/components/ui/`）：**
- `AdminPageHeader`：图标、标题、说明、统计、刷新按钮。
- `AdminAlert`：error、success、warning、info。
- `AdminLoadingState`：统一 loading 区块。
- `AdminEmptyState`：统一空状态。
- `AdminPagination`：统一上一页、下一页、范围文案。
- `AdminFilterSection`：统一筛选区外框、标题和布局。
- `AdminDangerButton`：统一危险按钮视觉和 disabled 状态。

**领域业务组件（放在 `apps/admin/components/{domain}/`）：**
- `components/users/CreateUserPanel`：创建用户表单
- `components/users/UserDetailPanel`：用户详情面板
- `components/users/WalletSection`：余额和批次展示
- `components/users/MembershipSection`：会员信息管理
- `components/users/DangerZone`：危险操作区域
- `components/billing/ReconcileSection`：计费预留修复
- `components/system/AuditLogViewer`：审计日志查看器

**单页面专用组件（放在页面同目录下 `components/`）：**
- 如果组件只在一个页面使用且逻辑紧密耦合，可放在 `app/(dashboard)/{page}/components/`

应用优先级：

1. 先应用到 `/billing` 和 `/users`。
2. 再应用到 `/gifts`、`/referrals`。
3. 最后逐步应用到公告、关于收支、日志。

### 验收标准

- 不改变页面功能。
- 样式与现有 `globals.css` token 一致。
- 窄屏宽度下不出现输入框或按钮文字溢出。
- TypeScript 通过。
- 组件文件按照上述目录规范组织。

## P1 任务七：筛选条件同步到 URL

### 问题

部分页面的筛选条件只存在本地 state，无法分享排障链接。`skills/detail` 已经有 query 保留，但用户、账单、消息等页面不完整。

### 实现要求

1. 用户页同步 search 和 page。
2. 账单页同步 user_id、order_status、pay_type、wallet_kind、hold_state、charge_state 和各表页码。
3. 消息页同步 user_id、account_id、session_id。
4. 日志页同步 user_id、account_id、request_id。
5. 更新 URL 时避免导致输入每个字符都整页跳转。推荐 debounce 或仅在提交筛选时同步。

### 验收标准

- 刷新页面后筛选状态保持。
- 复制 URL 给别人可复现同一视图。
- 静态导出路径兼容 `toAdminDocumentHref`。

## P2 任务八：用户选择器改为可搜索服务端选择

### 问题

`skills`、`messages`、`logs` 等页面使用 `admin.users({ page_size: 100 })` 作为下拉数据来源。用户量超过 100 后，后面的用户不可选。

### 实现要求

1. 新增或复用 `AdminUserSelect` 组件。
2. 输入手机号或 ID 后调用 `admin.users` 搜索。
3. 支持清空选择。
4. 保留 URL query 中已有的 user_id。
5. 不要一次性拉全量用户。

### 验收标准

- 用户数超过 100 时仍可搜索到目标用户。
- 已选用户有明确显示。
- 网络错误有反馈。
- 不影响 messages、logs、skills 的原有筛选行为。

## P2 任务八：用户选择器改为可搜索服务端选择

### 问题

`skills`、`messages`、`logs` 等页面使用 `admin.users({ page_size: 100 })` 作为下拉数据来源。用户量超过 100 后，后面的用户不可选。

### 实现要求

1. 新增或复用 `AdminUserSelect` 组件。
2. 输入手机号或 ID 后调用 `admin.users` 搜索。
3. 支持清空选择。
4. 保留 URL query 中已有的 user_id。
5. 不要一次性拉全量用户。

### 验收标准

- 用户数超过 100 时仍可搜索到目标用户。
- 已选用户有明确显示。
- 网络错误有反馈。
- 不影响 messages、logs、skills 的原有筛选行为。

## P2 任务九：运行状态变成运营诊断入口

### 问题

`/status` 当前是只读指标页，没有自动刷新、阈值、异常入口和日志联动。

### 实现要求

1. 增加自动刷新开关，默认关闭或 30 秒。
2. 增加异常卡片。
   - 正在处理会话过高。
   - 今日 Token 消耗异常高。
   - 计费预约冻结中数量异常。
   - 无可用官方模型。
3. 每个异常卡片给出跳转入口。
   - 到 logs。
   - 到 billing。
   - 到 system models。
4. 保持页面轻量，不引入图表库。

### 验收标准

- 管理员能从状态页直接进入排障页面。
- 自动刷新可停止。
- 窄屏宽度下页面元素不重叠。

## 暂不纳入本轮

以下内容有价值，但本轮不做，避免范围过大：

- 新增数据库 migration。
- 新增完整独立审计中心路由。
- 权限角色管理 UI。
- 多管理员账号体系。
- 后台操作原因落库。
- CSV 批量导入用户。
- 真实支付对账或退款操作。
- 新设计系统依赖，例如 Carbon、Fluent、Radix Themes。
- 大规模视觉重设计。

## 文件级改动建议

### `apps/admin/lib/admin-api.ts`

必须修改：

- 修正 `AdminScope`。
- 增加 `AdminBalanceGrant` 类型。
- 增加 `userBalanceGrants`。
- 增加 `reconcileBillingReservations`。
- 增加 reconcile 返回类型。

建议修改：

- 给 403 提供更明确 helper 或复用 `isAdminForbiddenError`。
- 对敏感 JSON 展示增加前端脱敏 helper，可放在独立 util。

### `apps/admin/lib/admin-navigation.ts`

必须修改：

- 从 role-based access 迁移到 scope-based access。
- 保留 `/admin/*` 到本地路径的兼容逻辑。
- 增加路径所需 scope 映射。

### `apps/admin/components/admin-sidebar.tsx`

必须修改：

- 接收 session 或 scopes。
- `navItems` 使用 requiredScopes。
- user_manager 只显示用户和消息。

建议修改：

- 菜单按运营、用户、内容、系统分组，但不要先做大视觉重设计。

### `apps/admin/app/(dashboard)/layout.tsx`

必须修改：

- 保存完整 session。
- 传 session 给 sidebar。
- 403 显示权限错误页，而不是统一回登录页。

建议修改：

- 后续可抽 `AdminSessionProvider`，本轮如果改动过大可先不抽。

### `apps/admin/app/(dashboard)/users/page.tsx`

必须修改：

- 根据 scopes 控制操作可见性。
- 添加赠送余额批次展示。
- user_manager 创建用户角色受限（根据产品策略方案 A 或 B）。
- owner 保持完整管理能力。

建议拆分（放在 `apps/admin/components/users/`）：

- `CreateUserPanel`：创建用户表单
- `UserDetailPanel`：用户详情面板
- `WalletSection`：余额和批次展示
- `MembershipSection`：会员信息管理
- `DangerZone`：危险操作区域

### `apps/admin/app/(dashboard)/billing/page.tsx`

必须修改：

- 添加 reconcile admin-api 调用。
- 添加手动修复陈旧预留入口。
- 成功后刷新数据。

建议修改：

- 复用共享分页组件和筛选组件。

### `apps/admin/app/(dashboard)/system/models/page.tsx`

必须修改：

- 展示 `audit_logs`。
- 对敏感字段脱敏。

### `apps/api/src/interfaces/http/admin-routes.ts`

必须修改：

- `POST /users` 根据 principal 限制可创建角色。
- 必要时补充测试覆盖。

不建议本轮修改：

- route prefix 兼容逻辑。
- admin auth rate limit。
- 管理密钥设计。

## 测试计划

### TypeScript 和构建检查

必须运行：

```bash
pnpm --filter fateclaw-admin exec tsc --noEmit
pnpm run build:admin
pnpm --filter @fateclaw/api typecheck
```

如果改到 contracts 或 API 测试，追加：

```bash
pnpm test
```

### P0 权限闭环测试

**单元测试（apps/admin/lib/__tests__/）：**

创建或更新 `admin-navigation.test.ts`：

```typescript
// 测试 hasAdminScope helper
describe('hasAdminScope', () => {
  test('admin:* 可以通过任何 scope 检查', () => {
    expect(hasAdminScope(['admin:*'], 'users:read')).toBe(true)
    expect(hasAdminScope(['admin:*'], 'users:create')).toBe(true)
    expect(hasAdminScope(['admin:*'], 'messages:read')).toBe(true)
  })

  test('具体 scope 只能通过对应检查', () => {
    expect(hasAdminScope(['users:read'], 'users:read')).toBe(true)
    expect(hasAdminScope(['users:read'], 'users:create')).toBe(false)
    expect(hasAdminScope(['users:read'], 'admin:*')).toBe(false)
  })

  test('多个 scope 的任意匹配', () => {
    expect(hasAdminScope(['users:read', 'messages:read'], 'messages:read')).toBe(true)
    expect(hasAdminScope(['users:read', 'messages:read'], 'admin:*')).toBe(false)
  })
})

// 测试路径访问控制
describe('canAdminSessionAccessPath', () => {
  test('owner 可以访问所有路径', () => {
    const session = { role: 'owner', scopes: ['admin:*'] }
    expect(canAdminSessionAccessPath(session, '/users')).toBe(true)
    expect(canAdminSessionAccessPath(session, '/billing')).toBe(true)
    expect(canAdminSessionAccessPath(session, '/system/models')).toBe(true)
  })

  test('user_manager 只能访问用户和消息路径', () => {
    const session = { role: 'user_manager', scopes: ['users:read', 'users:create', 'messages:read'] }
    expect(canAdminSessionAccessPath(session, '/users')).toBe(true)
    expect(canAdminSessionAccessPath(session, '/messages')).toBe(true)
    expect(canAdminSessionAccessPath(session, '/billing')).toBe(false)
    expect(canAdminSessionAccessPath(session, '/system/models')).toBe(false)
  })
})
```

创建或更新 `admin-api.test.ts`。当前 `apps/admin/lib/admin-api.ts` 对外使用的是 `admin` 单例对象，测试不要虚构新的 API client 类；应 mock `global.fetch` 后调用新增的 `admin.userBalanceGrants` 和 `admin.reconcileBillingReservations`：

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { admin, clearAdminKey, setAdminKey } from '@/lib/admin-api';

describe('admin API additions', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    setAdminKey('owner-test-key');
  });

  afterEach(() => {
    clearAdminKey();
    vi.unstubAllGlobals();
  });

  test('userBalanceGrants 拼接正确路径', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await admin.userBalanceGrants('user123', { limit: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/users/user123/balance/grants?limit=20',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Admin-Key': 'owner-test-key',
        }),
      }),
    );
  });

  test('reconcileBillingReservations 使用 POST 请求', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ released: 1, requestIds: ['req_1'] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await admin.reconcileBillingReservations({
      stale_ms: 3600000,
      limit: 50,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/billing/reconcile',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ stale_ms: 3600000, limit: 50 }),
        headers: expect.objectContaining({
          'X-Admin-Key': 'owner-test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});
```

**集成测试（apps/api/tests/）：**

创建或更新 `admin-routes.test.ts`：

```typescript
describe('POST /api/admin/users - 角色创建限制', () => {
  test('owner 可以创建 admin 系统用户角色', async () => {
    const response = await request(app)
      .post('/api/admin/users')
      .set('X-Admin-Key', ownerAdminKey)
      .send({
        phone: '13800000001',
        password: 'password123',
        role: 'admin',
        phone_verified: true,
      })
    
    expect(response.status).toBe(201)
    expect(response.body.success).toBe(true)
    expect(response.body.id).toEqual(expect.any(String))
    // 如果测试环境可读取数据库，再断言创建出的用户 role 为 admin。
  })

  test('user_manager 不能创建 admin 系统用户角色', async () => {
    const response = await request(app)
      .post('/api/admin/users')
      .set('X-Admin-Key', userManagerAdminKey)
      .send({
        phone: '13800000002',
        password: 'password123',
        role: 'admin',
        phone_verified: true,
      })
    
    expect(response.status).toBe(403)
    expect(response.body.error).toContain('无权创建')
  })

  test('user_manager 可以创建 consumer（方案 A）', async () => {
    const response = await request(app)
      .post('/api/admin/users')
      .set('X-Admin-Key', userManagerAdminKey)
      .send({
        phone: '13800000003',
        password: 'password123',
        role: 'consumer',
        phone_verified: true,
      })
    
    expect(response.status).toBe(201)
    expect(response.body.success).toBe(true)
    expect(response.body.id).toEqual(expect.any(String))
  })

  // 如果执行方案 B，追加测试 creator 和 both
})
```

### P1 接口补齐测试

**前端集成测试建议：**

在 `apps/admin/tests/` 中创建组件或页面集成测试（可选，如已有测试框架）：

```typescript
// 测试赠送余额批次显示
test('用户详情页显示赠送余额批次', async () => {
  // mock API 返回
  // 验证页面渲染批次列表
  // 验证状态文案正确
})

// 测试 reconcile 操作
test('账单页可以执行 reconcile', async () => {
  // mock API 返回
  // 验证确认弹窗出现
  // 确认后验证请求发出
  // 验证成功后数据刷新
})

// 测试审计日志显示
test('系统配置页显示审计日志', async () => {
  // mock API 返回 audit_logs
  // 验证日志列表渲染
  // 验证敏感字段已脱敏
})
```

### 最低测试覆盖清单

执行完成后，至少应有以下测试通过：

- ✅ `hasAdminScope` 的 3 个场景（admin:*、具体 scope、多 scope）
- ✅ `canAdminSessionAccessPath` 的 owner 和 user_manager 场景
- ✅ `userBalanceGrants` 和 `reconcileBillingReservations` 路径拼接
- ✅ 后端 `POST /users` 的角色创建限制（owner 可创建 admin，user_manager 不可）
- ✅ 后端 `POST /users` 的 user_manager 白名单验证（方案 A 或 B）

如果没有现成的测试框架或测试编写困难，至少要通过 TypeScript 检查和手动验证。

### 手动验证

不要求图片或可视产物。记录文字版验证结果即可，例如”owner 可见全部菜单，user_manager 仅可见用户和消息”，并附关键命令输出摘要。

#### 准备工作

1. 确保已有 owner 和 user_manager 两个测试管理密钥
2. 确保 API 服务已启动且可访问（执行过程中不重启）
3. 准备至少一个测试用户账号（用于验证用户详情、赠送余额批次等功能）
4. 启动 admin 前端：`pnpm dev:admin`

#### Owner 身份验证清单

使用 owner 管理密钥登录后，逐项验证：

- [ ] **菜单完整性**：侧边栏显示所有菜单项（总览、运行状态、账单、用户、消息、日志、技能、工作流、系统配置、礼品码、公告、关于、邀请）
- [ ] **用户管理**：访问 `/users`，列表正常显示
- [ ] **用户详情 - 完整权限**：访问 `/users/{id}`，能看到以下操作按钮：
  - [ ] 调整余额
  - [ ] 赠送余额
  - [ ] 设置会员
  - [ ] 停用会员
  - [ ] 重置密码
  - [ ] 清空日志
  - [ ] 删除用户
- [ ] **赠送余额批次**：在用户详情页，余额区域下方显示”赠送余额批次”列表
  - [ ] 显示批次的总额、剩余、状态、来源、过期时间
  - [ ] 有”显示已耗尽和已过期批次”开关
  - [ ] 发放赠送余额后，新批次出现在列表
- [ ] **账单管理**：访问 `/billing`，页面正常显示
- [ ] **计费预留修复**：在账单页能看到”修复陈旧预留”或类似操作入口
  - [ ] 点击后出现确认弹窗，说明会释放陈旧冻结预留
  - [ ] 确认后请求发出，成功后显示释放数量
  - [ ] 页面自动刷新 stats、reservations 和 wallet transactions
- [ ] **系统配置**：访问 `/system/models`，页面正常显示
- [ ] **配置审计**：在模型配置页底部看到”配置审计”或”审计日志”区域
  - [ ] 显示 action、target_type、target_key、actor_user_id、created_at
  - [ ] before_json 和 after_json 默认折叠，可展开查看
  - [ ] 敏感字段（api_key、secret 等）已脱敏或不显示明文
- [ ] **创建用户**：在用户页点击”创建用户”，角色下拉包含所有角色（consumer、creator、both、admin）

#### User_manager 身份验证清单

使用 user_manager 管理密钥登录后，逐项验证：

- [ ] **菜单受限**：侧边栏只显示”用户”和”消息”两个菜单项
- [ ] **路径拦截 - billing**：手动访问 `/billing`，显示”无权访问该管理功能”或类似权限错误提示（不是登录页重定向）
- [ ] **路径拦截 - system**：手动访问 `/system/models`，显示权限错误提示
- [ ] **路径拦截 - gifts**：手动访问 `/gifts`，显示权限错误提示
- [ ] **用户列表**：访问 `/users`，列表正常显示
- [ ] **用户详情 - 受限权限**：访问 `/users/{id}`，以下 owner 操作不可见或不可点击：
  - [ ] 看不到或不可点击”调整余额”
  - [ ] 看不到或不可点击”赠送余额”
  - [ ] 看不到或不可点击”设置会员”
  - [ ] 看不到或不可点击”停用会员”
  - [ ] 看不到或不可点击”重置密码”
  - [ ] 看不到或不可点击”清空日志”
  - [ ] 看不到或不可点击”删除用户”
- [ ] **创建用户 - 角色受限**：点击”创建用户”
  - [ ] 方案 A：角色下拉只有 `consumer`
  - [ ] 方案 B：角色下拉有 `consumer`、`creator`、`both`，但没有 `admin`
- [ ] **后端角色限制**：使用开发者工具或 API 客户端，尝试直接发送创建 `admin` 角色的请求
  - [ ] 收到 403 错误响应
  - [ ] 错误消息包含中文说明（如”无权创建该角色用户”）
- [ ] **消息管理**：访问 `/messages`，页面正常显示（如有 messages:read scope）

#### 窄屏布局验证

将浏览器窗口调整到窄屏宽度（如 375px 或 768px），验证：

- [ ] 侧边栏变为抽屉，可打开和关闭
- [ ] 用户详情展开后不横向溢出
- [ ] 账单筛选区不遮挡按钮
- [ ] 审计 JSON 展开后可横向滚动或折行，不破坏布局
- [ ] 所有输入框和按钮文字无溢出

#### 验证结果记录格式

建议格式：

```
=== Owner 验证 ===
✅ 侧边栏显示全部 13 个菜单项
✅ 用户详情显示所有 owner 操作按钮
✅ 赠送余额批次列表正常显示，包含 3 个批次
✅ 账单页 reconcile 成功释放 2 个陈旧预留
✅ 系统配置页显示 15 条审计日志，敏感字段已脱敏
✅ 创建用户角色下拉包含 consumer/creator/both/admin

=== User_manager 验证 ===
✅ 侧边栏只显示用户和消息 2 个菜单项
✅ 访问 /billing 显示”无权访问该管理功能”
✅ 访问 /system/models 显示权限错误
✅ 用户详情不显示 owner 操作按钮
✅ 创建用户角色下拉只有 consumer（方案 A）
✅ 构造 POST /users {role: 'admin'} 请求返回 403，错误消息：”user_manager 无权创建 admin 角色用户”

=== 窄屏布局 ===
✅ 375px 宽度下所有页面元素无溢出
✅ 审计 JSON 展开后可横向滚动
```

## 完成报告要求

执行完成后，AI 需要输出：

- 修改了哪些文件。
- P0、P1、P2 各完成了哪些项。
- 哪些项因为范围或产品决策没有做。
- 运行了哪些命令，结果如何。
- 本地验证了 owner 和 user_manager 哪些路径，具体验证结果（使用上述验证清单格式）。
- 是否存在剩余权限风险。
- 是否存在需要用户确认的产品策略（如 user_manager 可创建哪些用户角色，如果执行前未确认）。

## 错误处理规范

为保证用户体验一致性，所有 admin 页面必须遵循统一的错误处理规范：

### 错误分类和展示

1. **403 权限错误**
   - 检测：使用 `isAdminForbiddenError(error)` 判断
   - 展示：显示权限提示卡片或弹窗
   - 文案示例：
     - "您没有权限执行此操作"
     - "user_manager 无权访问该管理功能"
     - "仅 owner 可以执行此操作"
   - 操作：提供返回首页或可访问页面的链接

2. **网络错误**
   - 检测：网络超时、连接失败、DNS 解析失败
   - 展示：显示通用错误提示
   - 文案："网络请求失败，请检查网络连接后重试"
   - 操作：提供"重试"按钮

3. **业务错误**
   - 检测：后端返回 4xx/5xx 且包含 `error` 字段
   - 展示：直接显示后端返回的 `error` 字段内容（已经是中文）
   - 示例：
     - "该手机号已被使用"
     - "user_manager 无权创建 admin 角色用户"
     - "赠送余额金额必须大于 0"

4. **未知错误**
   - 检测：无法归类到上述类型的错误
   - 展示：显示通用错误 + request_id（如有）
   - 文案："操作失败，请稍后重试"
   - 附加：如果响应中包含 `request_id`，显示"错误追踪 ID: {request_id}"

### 实现建议

在 `apps/admin/lib/admin-api.ts` 或新建 `apps/admin/lib/error-handling.ts` 中提供统一工具：

```typescript
export function getErrorMessage(error: unknown): string {
  // 403 权限错误
  if (isAdminForbiddenError(error)) {
    return '您没有权限执行此操作'
  }
  
  // 业务错误
  if (error && typeof error === 'object' && 'error' in error) {
    return String(error.error)
  }
  
  // 网络错误
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return '网络请求失败，请检查网络连接后重试'
  }
  
  // 未知错误
  return '操作失败，请稍后重试'
}

export function shouldShowRetry(error: unknown): boolean {
  // 权限错误不应显示重试
  if (isAdminForbiddenError(error)) {
    return false
  }
  // 网络错误应显示重试
  return true
}
```

### 页面应用

所有页面的 catch 块应使用统一错误处理：

```typescript
try {
  await admin.someOperation()
} catch (error) {
  setErrorMessage(getErrorMessage(error))
  setShowRetry(shouldShowRetry(error))
}
```

### 确认弹窗错误展示

危险操作确认后，如果执行失败，错误应在确认弹窗内或紧邻位置展示，不要静默失败或只在控制台输出。

## 风险和注意事项

- admin 是静态导出站点，前端隐藏按钮不是安全边界，后端必须继续强校验。
- 系统用户角色中的 `admin` 不等同于管理员身份（owner/user_manager），但仍可能影响产品权限语义，低权限管理员不应随意创建。
- 不要把管理密钥、API key、private key、token 直接展示在审计日志或错误消息里。
- 账单 reconcile 是数据修复操作，必须确认后执行，并显示影响数量。
- 用户删除、清日志、归档清理等操作不能只靠颜色提示，必须有明确影响范围说明。
- 大页面拆分时不要改业务行为，先抽组件再重排逻辑。

## 术语表

为避免混淆，本文档统一使用以下术语：

| 术语 | 含义 | 存储位置 | 示例值 |
|------|------|---------|--------|
| **系统用户角色** | 存储在 users 表的 role 字段，表示用户在产品中的权限级别 | `users.role` | `consumer`, `creator`, `both`, `admin` |
| **管理员身份** | 管理密钥对应的 principal.role，表示后台管理员的身份类型 | `admin_principal.role` | `owner`, `user_manager` |
| **管理员权限作用域** | principal.scopes 中的具体权限标识，控制管理员可执行的操作 | `admin_principal.scopes` | `admin:*`, `users:read`, `users:create`, `messages:read` |
| **管理密钥** | 用于登录 admin 后台的认证凭证，对应一个管理员身份和作用域集合 | 环境变量或密钥管理系统 | - |

**重要区分：**
- `admin` 系统用户角色：是 users 表中的普通用户，可能在产品中有特殊权限
- `owner` 管理员身份：是后台管理系统的最高权限管理员，可以访问所有管理功能
- 两者完全独立：创建一个 `admin` 系统用户角色的用户，不会让该用户获得后台管理权限
