# 公告系统设计

## 背景

FateClaw 需要一个面向用户的运营公告系统，用于发布活动、版本更新、维护通知等公开信息。首版目标是让管理员能在后台维护公告，让用户在 www 站点全站看到当前重要公告，并能查看历史公告列表和详情。

本设计只覆盖运营公告，不覆盖账号、订单、余额、会员、风控等个人通知。

## 成功标准

- 管理员可以在 admin 后台创建、编辑、发布、归档公告。
- www 用户站登录前后都能看到当前最高优先级公告横幅。
- 横幅可由用户关闭，关闭状态仅保存在当前浏览器。
- 用户可以通过横幅进入公开公告列表和公告详情。
- 草稿、归档、未到开始时间、已过结束时间的公告不会出现在横幅。
- 公告正文支持 Markdown 展示。
- 实现不引入用户级已读表、弹窗、多语言、人群定向或曝光统计。

## 范围

### 首版包含

- 运营公告管理。
- 公告状态：`draft`、`published`、`archived`。
- 发布控制：优先级、开始时间、结束时间。
- 内容字段：标题、摘要、Markdown 正文、slug。
- 可选行动按钮：按钮文案、跳转链接。
- www 全站顶部公告横幅。
- 公开公告列表页和详情页。
- 浏览器本地横幅关闭状态。

### 首版不包含

- 弹窗公告。
- 跨设备已读状态。
- 未读数量。
- 指定用户或人群投放。
- 多语言公告内容。
- 曝光、点击、转化统计。
- 个人通知中心。

## 用户体验

www 用户站全站展示一个公告横幅，不在 admin 后台展示。横幅选择当前有效且优先级最高的一条公告。用户点击关闭后，该浏览器不再显示同一版本公告；如果公告内容被管理员更新，横幅应重新出现。

横幅提供两个入口：

- 查看详情：进入该公告详情页。
- 查看全部：进入公告列表页。

公告列表页使用公开 URL `/announcements`，详情页使用 `/announcements/[slug]`。首版不在侧边栏或右上角增加固定公告入口，避免把运营公告误导成个人通知系统。

## 数据设计

新增 `announcements` 表，追加到现有数据库迁移体系，不改写历史 migration。

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 公告 ID，建议使用 `announcement-${uuid}` |
| `slug` | `TEXT NOT NULL UNIQUE` | 公开详情页路径标识 |
| `title` | `TEXT NOT NULL` | 标题 |
| `summary` | `TEXT NOT NULL DEFAULT ''` | 横幅和列表摘要 |
| `body_markdown` | `TEXT NOT NULL` | Markdown 正文 |
| `status` | `TEXT NOT NULL DEFAULT 'draft'` | `draft`、`published`、`archived` |
| `priority` | `INTEGER NOT NULL DEFAULT 0` | 数值越大越优先 |
| `starts_at` | `TIMESTAMPTZ DEFAULT NULL` | 可见开始时间，空值表示立即开始 |
| `ends_at` | `TIMESTAMPTZ DEFAULT NULL` | 可见结束时间，空值表示不自动结束 |
| `cta_label` | `TEXT DEFAULT NULL` | 可选行动按钮文案 |
| `cta_href` | `TEXT DEFAULT NULL` | 可选行动按钮链接 |
| `published_at` | `TIMESTAMPTZ DEFAULT NULL` | 首次发布或最近发布的时间 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | 创建时间 |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | 更新时间 |

约束：

- `status IN ('draft', 'published', 'archived')`。
- `slug` 最多 80 字符，`title` 最多 120 字符，`summary` 最多 280 字符，`body_markdown` 最多 20000 字符，`cta_label` 最多 40 字符。
- `ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at`。
- `cta_href` 只允许站内相对路径或 `https://` 外链，不允许 `javascript:` 等脚本协议。

索引：

- `idx_announcements_status_window_priority`：支持当前有效公告查询。
- `idx_announcements_published_at`：支持公开列表排序。
- `idx_announcements_updated_at`：支持后台列表排序。

## API 设计

### 公开 API

公开 API 放在现有 `/api/public` 下。

`GET /api/public/announcements/active`

返回当前横幅公告或 `null`。选择规则：

1. `status = 'published'`
2. `starts_at IS NULL OR starts_at <= NOW()`
3. `ends_at IS NULL OR ends_at > NOW()`
4. 按 `priority DESC, published_at DESC, updated_at DESC` 选择第一条

`GET /api/public/announcements`

返回公开公告列表。列表包含 `published` 且已经到达 `starts_at` 的公告，按 `published_at DESC, updated_at DESC` 排序。首版可包含已结束公告，方便历史留档；草稿、归档、未到开始时间的公告不返回。

`GET /api/public/announcements/:slug`

返回单条公开公告详情。草稿、归档、未到开始时间的公告返回 404；已结束公告仍可访问，作为历史留档。

### 管理 API

管理 API 放在现有 `/api/admin` 下，仅 owner 可访问。

`GET /api/admin/announcements`

返回公告管理列表，包含草稿、已发布、归档。

`POST /api/admin/announcements`

创建公告。可创建草稿，也可直接发布。直接发布时设置 `published_at`。

`PATCH /api/admin/announcements/:id`

更新公告字段和状态。状态从非 `published` 变为 `published` 时设置 `published_at`。如果已发布公告被更新，`updated_at` 变化会让用户浏览器重新显示横幅。

`DELETE /api/admin/announcements/:id`

删除草稿。已发布公告和归档公告首版建议不允许硬删，提示管理员使用归档，避免公开链接突然消失。

## 后端组织

沿用现有公开内容维护模式，不新增复杂层级。

- `apps/api/src/infrastructure/repositories/announcements-repository.ts`
  - SQL 读写、行标准化、当前有效公告选择。
- `apps/api/src/modules/admin/admin-service.ts`
  - 透出管理端公告函数，保持 `admin-routes.ts` 较薄。
- `apps/api/src/interfaces/http/public-routes.ts`
  - 注册公开公告接口。
- `apps/api/src/interfaces/http/admin-routes.ts`
  - 注册管理端公告接口和 zod 参数校验。
- `apps/api/src/infrastructure/migrations/definitions/*`
  - 追加公告表 migration。

新 public function、class、interface 需要中文 doc comment。非显然查询和状态转换需要中文注释解释原因。

## 前端组织

### www 用户站

- `apps/web/features/announcements/api.ts`
  - 封装公开公告 API。
- `apps/web/components/announcements/announcement-banner.tsx`
  - 展示当前公告横幅。
  - 读取 `/api/public/announcements/active`。
  - 使用 `localStorage` 记录关闭状态。
- `apps/web/app/announcements/page.tsx`
  - 公告列表页。
- `apps/web/app/announcements/[slug]/page.tsx`
  - 公告详情页。

横幅放在 `AppShell` 内，让公开页和登录后页面都能展示。关闭状态 key 建议包含公告 `id` 和 `updated_at`，例如：

```text
fateclaw:announcement:dismissed:<id>:<updated_at>
```

这样管理员更新公告后，横幅会自动重新出现。

Markdown 正文优先复用现有 Markdown 渲染能力，不新增富文本编辑器。

### admin 管理站

- `apps/admin/app/(dashboard)/announcements/page.tsx`
  - 列表和表单同页。
  - 支持创建、编辑、发布、归档、删除草稿。
- `apps/admin/lib/admin-api.ts`
  - 增加公告 DTO 和请求函数。
- `apps/admin/components/admin-sidebar.tsx`
  - 增加“公告”入口，仅 owner 可见。

后台首版使用 textarea 编辑 Markdown，不引入富文本编辑器。

## 校验与错误处理

- 标题不能为空。
- slug 不能为空，且只能包含小写字母、数字和连字符。
- Markdown 正文不能为空。
- slug 最多 80 字符，标题最多 120 字符，摘要最多 280 字符，Markdown 正文最多 20000 字符。
- `ends_at` 必须晚于 `starts_at`。
- CTA 文案和 CTA 链接要么都为空，要么都有效。
- CTA 链接只允许站内相对路径或 `https://`。
- slug 冲突返回 409 或 400，并给出中文错误。
- 管理端所有错误延续现有中文错误消息风格。

## 测试计划

后端测试：

- 草稿不会出现在公开列表、详情和 active 接口。
- 已发布且未过期公告可出现在公开列表和详情。
- active 接口按优先级和发布时间选择公告。
- 未到开始时间和已过结束时间的公告不会成为 active。
- 归档公告不公开展示。
- slug 冲突和无效 CTA 链接会被拒绝。
- 已发布公告不能被 DELETE 硬删。

前端测试：

- 公告 API client 解析列表、详情和 active 响应。
- 横幅在无 active 公告时不显示。
- 横幅关闭后同一 `id + updated_at` 不再显示。
- 公告 `updated_at` 变化后横幅重新显示。

验证命令按改动范围运行：

- 后端公告相关 Vitest。
- `pnpm --filter @fateclaw/api typecheck`。
- `pnpm --filter fateclaw-web exec tsc --noEmit`。
- `pnpm --filter fateclaw-admin exec tsc --noEmit`。

## 取舍

选择“顶部横幅 + 公告列表/详情”的轻量方案，是为了覆盖运营公告最核心的展示和留档需求，同时避免把首版做成完整通知中心。用户级已读、人群定向、多语言和统计都可以在未来独立设计，首版不为这些能力预留复杂表结构。

公告系统的真源放在 PostgreSQL，符合项目现有模式。前台关闭状态只放浏览器本地，避免为运营公告引入用户维度状态表。
