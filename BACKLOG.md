# 技术债 / 中长期改造 BACKLOG

来源：上线前 Review（2026-04），见 `~/.claude/plans/review-bug-wise-key.md`。

P0（上线阻断）和 P1（一周内补）已完成；本文件追踪 P2（3 个月内偿还）的中长期改造。这些改动**不影响上线稳定性**，但累积下去会拖慢迭代速度，建议按季度规划逐项处理。

每项给出：动机、范围、参考实现、验收标准。

---

## TD-1：引入 DB 迁移框架

**为什么改**

`src/infrastructure/db.ts:initDatabase()` 当前直接执行 50+ 条 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，无版本表、无回滚、无环境差异管理。生产数据库 schema 演进只能靠"代码部署后启动时自动 DDL"，这种模式：

- 无法在不部署代码的情况下修复 schema 问题
- 多副本同时启动时 DDL 之间存在竞争
- 无法预演迁移（dry-run）
- 难以回滚错误的 schema 变更

**范围**

- 引入 `node-pg-migrate`（推荐）或 `sqitch`
- 把 `src/infrastructure/db.ts:44-397` 的所有 DDL 提取为带版本号的 migration 文件（`migrations/0001_initial.sql` 起）
- 启动时不再自动建表，而是检查 schema_migrations 版本号，缺失则提示 `pnpm migrate up`
- 部署流程加入 `pnpm migrate up` 步骤（可在 Dockerfile entrypoint 里前置）

**验收**

- `initDatabase()` 不再包含 DDL，仅做连接 + 校验当前 migration 版本
- 新增字段时只能通过 `pnpm migrate create add_xxx` + 写 SQL，不能再 patch `db.ts`

---

## TD-2：拆分 src/infrastructure/db.ts

**为什么改**

`src/infrastructure/db.ts` 单文件 2500+ 行，承担：DDL 初始化、用户、账号、消息、会话、日志、技能、订阅、计费、配额、wallet 流水……所有领域混在一起。每次改动需要扫描整个文件确认上下文，code review 几乎不可能 diff-driven。

**范围**

- 按领域拆为：`src/db/index.ts`（pool + initDatabase 入口）、`db/user.ts`、`db/account.ts`、`db/message.ts`、`db/chat-session.ts`、`db/conversation-log.ts`、`db/skill.ts`、`db/billing.ts`、`db/wallet.ts`、`db/persona.ts`、`db/scheduled-task.ts`、`db/admin-query.ts`
- 保持现有所有 export 名称不变（外部代码 `import { ... } from './db.js'` 照旧），通过 barrel re-export 实现
- 单文件控制在 300 行以内

**验收**

- `src/infrastructure/db.ts` 仅做 re-export
- `wc -l src/db/*.ts` 每个文件 < 400 行
- 所有原 import 路径无需修改

---

## TD-3：messages 表主键改 UUID

**为什么改**

`messages` 表当前主键是 `(id, account_id)` 复合主键，`id` 在不同 account 下可重复。这导致：

- 外表（如 `conversation_logs.message_id`）无法用单一 FK 引用某条消息
- `storeMessage` 的 `ON CONFLICT (id, account_id)` 语义混淆（同 id 不同 account 是不同行）
- web chat 用 `web-${Date.now()}-...` 拼装 id 理论上可碰撞

**范围**

- 新增 `messages.uuid` 列（DEFAULT `gen_random_uuid()`），加唯一索引
- 数据迁移：批量回填 uuid
- 一段时间双写 + 灰度，确认所有查询都能用 uuid 后切换主键

**验收**

- `messages` 主键改为 uuid（单列）
- 旧的 `(id, account_id)` 改为唯一索引保留兼容查询
- 新写入消息只填 uuid，不再依赖 sender 端生成的 id 唯一性

---

## TD-4：accounts.user_id 重命名

**为什么改**

`accounts` 表有两个语义混淆的列：
- `user_id`：微信侧用户 id（不是平台 user）
- `owner_id`：平台 user id（绑定时设置）

代码里 `account.user_id` 经常被误读为"平台用户"。`storeMessage` 用 `account.user_id` 做 sender 字段更增加歧义。

**范围**

- DB 列改名：`accounts.user_id` → `accounts.wechat_user_id`
- 同步更新所有 query 和 TS 类型
- 新增 FK：`wechat_user_id` 应当软引用 iLink 数据（可不加 FK，但加 NOT NULL 或显式注释）
- 检查 admin 后台显示是否仍然清晰

**验收**

- 全代码搜索 `user_id` 在 `accounts` 上下文中已替换为 `wechat_user_id`
- 文档 / 注释 / API 响应字段同步更新

---

## TD-5：长列表虚拟化

**为什么改**

- `apps/web/app/admin/(dashboard)/logs/page.tsx`：用"加载更多"模式，所有日志保留在 DOM；每个 LogCard 内部还可展开 transcript / agent graph，长会话用户可达数千 DOM 节点
- `web/app/chat/page.tsx`：每页 20 条但 `allMsgs` 全量在内存

**范围**

- 引入 `@tanstack/react-virtual`
- logs 页面把 `LogCard` 列表改为虚拟化，可见区外的 LogCard 不挂载（注意展开态需要受控）
- chat 页消息列表同样虚拟化；保持 scroll 锚点行为（新消息追加自动滚到底部）

**验收**

- logs 页加载 500+ 条不卡顿
- 内存占用稳定（对比改造前 chrome devtools heap snapshot）
- 不破坏现有锚点跳转 / 高亮 / 复制行为

---

## 已完成（P0/P1）

完整修复列表见 `~/.claude/plans/review-bug-wise-key.md`。摘要：

- **A 安全**：JWT 强密钥校验、CORS 白名单、captcha 独立密钥、限流迁 Redis、bot_token 脱敏、admin_key 改 sessionStorage
- **B 删除链路**：deleteAccount 补全引用清理、API 串接 stop polling/listener/agent、poller 支持 stop、local-runner 并发锁
- **C 进程生命周期**：统一 shutdown、daemon graceful drain、生产 logger JSON
- **D Agent Runner**：Pi 确定性工具超时、AbortSignal.any、XUAN_API_KEY 条件注入、JSON.parse 守护
- **E 前端**：dashboard pollStatus abort/超时、ai-chat fetchVersion、skills 异步 catch、统一 api.ts、markdown 防 XSS
- **F P1**：advisory_xact_lock 计费串行、purgeExpiredTraceEvents 分批、列表分页、conversation_log metrics、未绑定账号 reject、工具目录缓存、dashboard 预设校验、admin 部署文档、hasLoadedOnceRef 时序、全局 ErrorBoundary
- **G P2 短改**：模型 ID 集中、`/api/ready` 探针、captcha nonces 迁 Redis
