# FateClaw API Reference

> Base URL: `http://localhost:3000`（可通过 `API_PORT` 环境变量修改）

## 路由清单

当前 Fastify 装配的 API 前缀：

- `/api/auth`
- `/api/account`
- `/api/chat-sessions`
- `/api/messages`
- `/api/paipan`
- `/api/tasks`
- `/api/skills`
- `/api/billing`
- `/api/admin`
- `/api/health`
- `/api/ready`

## 认证

除注册和登录外，所有接口需要在请求头中携带 JWT：

```
Authorization: Bearer <token>
```

---

## Auth 认证

### POST /api/auth/register

注册新用户。

**Request Body**

```json
{
  "phoneNumber": "13800138000",
  "password": "123456",
  "smsCaptchaCode": "123456"
}
```

| 字段           | 类型   | 必填 | 说明               |
| -------------- | ------ | ---- | ------------------ |
| phoneNumber    | string | 是   | 中国大陆手机号     |
| password       | string | 是   | 至少 6 位          |
| smsCaptchaCode | string | 是   | 6 位短信验证码     |

**Response 201**

```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "phone": "138****8000",
    "phone_masked": "138****8000",
    "phone_verified": true,
    "role": "consumer",
    "purchased_coins": 0,
    "bonus_coins": 0,
    "reserved_coins": 0,
    "created_at": "2026-03-28T10:00:00.000Z"
  }
}
```

**Error 400**

```json
{ "error": "该手机号已被注册" }
```

---

### POST /api/auth/login

用户登录，返回 JWT。

**Request Body**

```json
{
  "phone": "13800138000",
  "password": "123456",
  "captcha_token": "captcha-token",
  "captcha_answer": "A7KD2"
}
```

| 字段           | 类型   | 必填 | 说明               |
| -------------- | ------ | ---- | ------------------ |
| phone          | string | 是   | 中国大陆手机号     |
| password       | string | 是   | 登录密码           |
| captcha_token  | string | 是   | 图形验证码 token   |
| captcha_answer | string | 是   | 图形验证码答案     |

**Response 200**

```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "phone": "138****8000",
    "phone_masked": "138****8000",
    "phone_verified": false,
    "role": "consumer",
    "purchased_coins": 100,
    "bonus_coins": 20,
    "reserved_coins": 0,
    "created_at": "2026-03-01T00:00:00.000Z"
  }
}
```

**Error 401**

```json
{ "error": "手机号或密码错误" }
```

---

### GET /api/auth/me

获取当前登录用户信息。需认证。

**Response 200**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "phone": "138****8000",
  "phone_masked": "138****8000",
  "phone_verified": false,
  "role": "consumer",
  "purchased_coins": 100,
  "bonus_coins": 20,
  "reserved_coins": 0,
  "created_at": "2026-03-01T00:00:00.000Z"
}
```

---

### POST /api/auth/send-sms-captcha

发送短信验证码。注册使用 `type = 1`，找回密码使用 `type = 0`。

**Request Body**

```json
{
  "type": 1,
  "phoneNumber": "13800138000",
  "captcha_token": "captcha-token",
  "captcha_answer": "A7KD2"
}
```

| 字段           | 类型   | 必填 | 说明                                  |
| -------------- | ------ | ---- | ------------------------------------- |
| type           | number | 是   | `1` 注册，`0` 找回密码                |
| phoneNumber    | string | 是   | 中国大陆手机号                        |
| captcha_token  | string | 是   | 图形验证码 token                      |
| captcha_answer | string | 是   | 图形验证码答案                        |

**Response 200**

```json
{ "success": true }
```

**Error 400**

```json
{ "error": "3分钟内只能发送一次短信验证码" }
```

---

## Account 账号管理

### GET /api/account

获取当前用户绑定的所有微信账号。需认证。

**Response 200**

```json
[
  {
    "id": "bot_123@im.bot",
    "user_id": "wxid_abc@im.wechat",
    "name": "老张",
    "base_url": "https://ilinkai.weixin.qq.com",
    "get_updates_buf": "",
    "enabled": 1,
    "created_at": "2026-03-01T00:00:00.000Z",
    "owner_id": "550e8400-e29b-41d4-a716-446655440000"
  }
]
```

> `bot_token` 字段不会返回。

---

### GET /api/account/:id

获取单个账号详情。需认证，只能查看自己绑定的账号。

**Path Params**

| 参数 | 说明              |
| ---- | ----------------- |
| id   | 账号 ID（bot_id） |

**Response 200** — 同上单个对象

**Error 404**

```json
{ "error": "账号不存在" }
```

---

### POST /api/account/:id/bind

将已有微信账号绑定到当前用户。需认证。

**Path Params**

| 参数 | 说明              |
| ---- | ----------------- |
| id   | 账号 ID（bot_id） |

**Response 200**

```json
{ "success": true }
```

**Error 403**

```json
{ "error": "该账号已绑定其他用户" }
```

---

## Messages 对话历史

### GET /api/messages/:accountId

获取指定账号的对话历史。需认证，只能查看自己账号的消息。

**Path Params**

| 参数      | 说明    |
| --------- | ------- |
| accountId | 账号 ID |

**Query Params**

| 参数  | 类型   | 默认 | 说明               |
| ----- | ------ | ---- | ------------------ |
| limit | number | 50   | 返回条数，最大 200 |

**Response 200**

```json
[
  {
    "id": "msg-1711612800000",
    "account_id": "bot_123@im.bot",
    "sender": "wxid_abc@im.wechat",
    "sender_name": "小明",
    "content": "你好",
    "timestamp": "2026-03-28T10:00:00.000Z",
    "is_from_me": 0,
    "is_bot_message": 0
  }
]
```

**Error 403**

```json
{ "error": "无权访问该账号的消息" }
```

---

## Chat Sessions 站内 AI Chat

以下接口均需认证，只能访问当前用户自己的会话。

| 方法   | 路径                                                                 | 说明                       |
| ------ | -------------------------------------------------------------------- | -------------------------- |
| GET    | `/api/chat-sessions`                                                 | 列出站内 AI Chat 会话      |
| POST   | `/api/chat-sessions`                                                 | 创建会话，可传 `{ "title": "..." }` |
| PATCH  | `/api/chat-sessions/s/:sessionId`                                    | 更新会话标题               |
| DELETE | `/api/chat-sessions/s/:sessionId`                                    | 删除会话                   |
| GET    | `/api/chat-sessions/s/:sessionId/messages`                           | 获取消息，支持 `limit` 和 `before` |
| POST   | `/api/chat-sessions/s/:sessionId/messages`                           | 发送消息，传 `content` 和可选 `selected_board_message_id` |
| GET    | `/api/chat-sessions/s/:sessionId/messages/:messageId/query-process`  | 获取脱敏后的查询过程时间线 |

---

## Paipan 纯排盘

以下接口均需认证。

纯排盘接口由 API 进程调用内部 TypeScript runner 并返回结构化 `skillContext`。预览请求不写入会话，也不需要模型 `llmRuntime`。

| 方法 | 路径                  | 说明                                               |
| ---- | --------------------- | -------------------------------------------------- |
| GET  | `/api/paipan/catalog` | 列出当前用户可直接排盘的系统排盘项                 |
| POST | `/api/paipan/preview` | 传 `skill` 和 `input` 执行预览，不写入会话         |
| POST | `/api/paipan/commit`  | 把预览或即时排盘结果提交到 AI Chat                |

`commit.target` 支持 `new_session_from_preview` 和 `current_session`。提交到当前会话时传 `sessionId`；也可以直接传 `skill` + `input` 让服务端即时排盘并写入。

---

## Tasks 定时任务

### GET /api/tasks/:accountId

获取指定账号的定时任务列表。需认证。

**Path Params**

| 参数      | 说明    |
| --------- | ------- |
| accountId | 账号 ID |

**Response 200**

```json
[
  {
    "id": "task-uuid",
    "account_id": "bot_123@im.bot",
    "prompt": "提醒喝水",
    "schedule_type": "cron",
    "schedule_value": "0 */2 * * *",
    "reminder_type": "water",
    "voice_text": null,
    "next_run": "2026-03-28T12:00:00.000Z",
    "last_run": "2026-03-28T10:00:00.000Z",
    "last_result": "已提醒",
    "status": "active",
    "created_at": "2026-03-01T00:00:00.000Z"
  }
]
```

---

### DELETE /api/tasks/:taskId

删除一个定时任务。需认证，只能删除自己账号下的任务。

**Path Params**

| 参数   | 说明    |
| ------ | ------- |
| taskId | 任务 ID |

**Response 200**

```json
{ "success": true }
```

**Error 404**

```json
{ "error": "任务不存在" }
```

---

## Skills 商店与创作者

### GET /api/skills/catalog

公开系统排盘兼容目录。无需认证。

### GET /api/skills

获取所有系统排盘兼容列表，合并全局状态、默认值和当前用户启用状态。需认证。

**Response 200**

```json
[
  {
    "name": "health-check",
    "description": "系统健康检查 — 验证 agent 运行环境是否正常。",
    "trigger": "当用户说「系统检查」「自检」时触发",
    "enabled": true
  }
]
```

---

### PATCH /api/skills/:name/toggle

切换某个系统排盘的启用状态。需认证。

**Path Params**

| 参数 | 说明       |
| ---- | ---------- |
| name | 系统排盘名称 |

**Request Body**

```json
{ "enabled": true }
```

**Response 200**

```json
{ "success": true }
```

**Error 404**

```json
{ "error": "Skill 不存在" }
```

---

### 用户自定义 Skill

- `GET /api/skills/user`：列出自有与已订阅 Skill
- `POST /api/skills/user`：创建 Markdown Skill Bundle
- `GET /api/skills/user/:id`：查看详情
- `PUT /api/skills/user/:id`：更新 Markdown Skill Bundle
- `DELETE /api/skills/user/:id`：软删除
- `PATCH /api/skills/user/:id/toggle`：启用或禁用
- `POST /api/skills/user/:id/share` / `DELETE /api/skills/user/:id/share`：开启或关闭私密分享
- `POST /api/skills/user/:id/publish` / `DELETE /api/skills/user/:id/publish`：公开上架或取消公开
- `GET /api/skills/shared/:token`：预览分享 Skill，无需认证
- `POST /api/skills/subscribe/:token`：订阅分享 Skill
- `PATCH /api/skills/subscribe/:id/toggle`：启用或禁用订阅
- `DELETE /api/skills/subscribe/:id`：取消订阅

`POST /api/skills/user` 请求体：

```json
{
  "skill_name": "六爻财运判断",
  "dir_name": "liuyao-money",
  "files": [
    {
      "path": "SKILL.md",
      "content": "---\nname: \"六爻财运判断\"\ndescription: \"六爻财运问题的读取入口\"\n---\n\n# 六爻财运判断\n\n## 推荐读取顺序\n\n- `index.md`\n- `docs/knowledge.md`\n"
    },
    {
      "path": "index.md",
      "content": "# 文件索引\n\n- `docs/knowledge.md`：主要知识正文\n"
    },
    {
      "path": "docs/knowledge.md",
      "content": "# 知识正文\n\n## 适用场景\n\n- 求财、合作、项目回款。\n"
    }
  ]
}
```

`PUT /api/skills/user/:id` 请求体：

```json
{
  "skill_name": "六爻财运判断",
  "files": [
    { "path": "SKILL.md", "content": "---\nname: \"六爻财运判断\"\ndescription: \"更新后的说明\"\n---\n\n# 六爻财运判断\n" },
    { "path": "index.md", "content": "# 文件索引\n" },
    { "path": "docs/knowledge.md", "content": "# 知识正文\n" }
  ]
}
```

`files` 只能包含安全相对路径下的 `.md` 文件，允许根文件 `SKILL.md`、`index.md`，以及 `docs/`、`examples/`、`notes/` 目录；必须包含 `SKILL.md`。响应中的 `skill_name` 与 `description` 从 `SKILL.md` frontmatter 同步。

### Bundle 与市场

- `POST /api/skills/bundles` / `GET /api/skills/bundles`：创建和列出自有 Bundle
- `PUT /api/skills/bundles/:id` / `DELETE /api/skills/bundles/:id`：更新或软删除 Bundle
- `POST /api/skills/bundles/:id/share` / `DELETE /api/skills/bundles/:id/share`：开启或关闭 Bundle 分享
- `POST /api/skills/bundles/:id/publish` / `DELETE /api/skills/bundles/:id/publish`：公开上架或取消公开
- `GET /api/skills/bundles/shared/:token`：预览分享 Bundle，无需认证
- `POST /api/skills/bundles/subscribe/:token`：批量订阅 Bundle
- `GET /api/skills/market`：公开 Skill 市场
- `GET /api/skills/bundles/market`：公开 Bundle 市场
- `GET /api/skills/subscriptions/mine`：我的订阅

---

## Billing 钱包与 Token 计费

### GET /api/billing

查询当前用户的钱包余额和本月 Token 计费概览。需认证。

**Response 200**

```json
{
  "monthly_tokens_used": 905000,
  "estimated_monthly_total_coins": 12.5,
  "purchased_coins": 100,
  "bonus_coins": 20,
  "reserved_coins": 0,
  "available_coins": 120
}
```

---

### GET /api/billing/usage

查询当前用户累计与今日消息、输入 Token、输出 Token、总 Token。需认证。

**Response 200**

```json
{
  "total_messages": 126,
  "total_input_tokens": 620000,
  "total_output_tokens": 285000,
  "total_tokens": 905000,
  "today_messages": 8,
  "today_input_tokens": 24000,
  "today_output_tokens": 6200,
  "today_total_tokens": 30200
}
```

---

### GET /api/billing/usage/daily

查询当前用户按日聚合的 Token 使用明细。需认证。

**Response 200**

```json
[
  {
    "date": "2026-05-06",
    "msg_count": 12,
    "input_tokens": 24000,
    "output_tokens": 6200,
    "total_tokens": 30200,
    "official_model_charge_coins": 0.36
  }
]
```

---

### GET /api/billing/status

查询状态页面展示的全站今日统计。需认证。

**Response 200**

```json
{
  "today_messages": 126,
  "registered_users": 42,
  "today_total_tokens": 905000,
  "processing_sessions": 3,
  "token_usage_series": [
    {
      "date": "2026-05-30",
      "input_tokens": 620000,
      "output_tokens": 285000,
      "total_tokens": 905000
    }
  ]
}
```

### POST /api/billing/recharge/orders

创建充值单并返回易支付收银台地址。需认证。

**Request Body**

```json
{
  "amount_yuan": "50.00",
  "pay_type": "alipay"
}
```

**Response 200**

```json
{
  "pay_url": "https://pay.example.com/...",
  "order": {
    "trade_id": "rc1770000000000123456",
    "pay_type": "alipay",
    "amount_yuan": "50.00",
    "amount_cents": 5000,
    "status": "pending"
  }
}
```

---

### GET /api/billing/recharge/orders

查询当前用户最近充值单。需认证。

---

### GET /api/billing/recharge/stats

查询当前用户充值统计。需认证。

**Response 200**

```json
{
  "total_paid_orders": 3,
  "total_recharge_cents": 15000,
  "total_recharge_yuan": "150.00",
  "last_paid_at": "2026-04-27T10:00:00.000Z"
}
```

---

### POST /api/billing/recharge/orders/:tradeId/sync

用户支付后主动向易支付查单并补偿入账。需认证。

---

### GET/POST /api/billing/recharge/notify

易支付异步通知入口。免登录，验签成功且金额一致后幂等入账，成功返回纯文本 `success`。

充值开关、金额范围、易支付网关、商户号和密钥保存在数据库表
`recharge_payment_config`。异步通知地址和支付完成返回地址由服务端按
`PUBLIC_BASE_URL` 或当前请求域名生成，下单时自动传给易支付。

---

## Health 健康检查

### GET /api/health

无需认证。

**Response 200**

```json
{ "status": "ok" }
```

### GET /api/ready

无需认证。检查 PostgreSQL 和 Redis 连接；任一依赖不可用时返回 `503`。

**Response 200**

```json
{
  "status": "ok",
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

---

## Admin 系统配置

> 以下接口均走 `/api/admin/*`，需要在请求头携带 `X-Admin-Key: <MANAGER_KEY>`。

### GET /api/admin/system-config

读取模型提供商列表、当前生效运行时配置和最近审计日志。

### GET /api/admin/recharge-config

读取充值配置。响应中的 `notify_url` / `return_url` 是服务端生成的展示值。

### PUT /api/admin/recharge-config

更新充值配置。回调地址由服务端生成，不需要提交。

**Request Body**

```json
{
  "enabled": true,
  "min_yuan": "1.00",
  "max_yuan": "1000.00",
  "epay_url_prefix": "https://pay.example.com/",
  "epay_platform_id": 1001,
  "epay_merchant_private_key": "-----BEGIN PRIVATE KEY-----...",
  "epay_platform_public_key": "-----BEGIN PUBLIC KEY-----...",
  "epay_merchant_key": "query-secret"
}
```

### POST /api/admin/system-config/providers

创建模型提供商。

**Request Body**

```json
{
  "provider_key": "openai-main",
  "provider_type": "openai",
  "usage_scope": "primary_agent",
  "display_name": "OpenAI Main",
  "enabled": true,
  "is_default": true,
  "priority": 0,
  "base_url": null,
  "default_model": "gpt-4o"
}
```

- `provider_type` 支持 `openai`、`openai_compatible`、`anthropic`、`gemini`
- `usage_scope` 支持 `primary_agent`（主对话）和 `xuan_interpretation`（玄学子 loop）

### PATCH /api/admin/system-config/providers/:id

更新模型提供商的非敏感字段。

### POST /api/admin/system-config/providers/:id/secret

更新模型提供商密钥（数据库加密存储）。

**Request Body**

```json
{
  "api_key": "sk-...",
  "auth_mode": "openai_api_key"
}
```

- `auth_mode` 支持 `openai_api_key`、`anthropic_api_key`、`claude_code_oauth_token`、`gemini_api_key`

### POST /api/admin/system-config/providers/:id/set-default

切换默认模型提供商。

### DELETE /api/admin/system-config/providers/:id

删除一个模型提供商（系统至少保留一个 provider 记录）。

---

## 通用错误格式

所有错误响应遵循统一格式：

```json
{ "error": "错误描述信息" }
```

| HTTP 状态码 | 含义                |
| ----------- | ------------------- |
| 400         | 请求参数错误        |
| 401         | 未登录或 token 过期 |
| 403         | 无权限操作          |
| 404         | 资源不存在          |
| 500         | 服务器内部错误      |

---

## 环境变量

| 变量                        | 默认值                  | 说明                               |
| --------------------------- | ----------------------- | ---------------------------------- |
| `API_PORT`                  | 3000                    | API 监听端口                       |
| `API_HOST`                  | 0.0.0.0                 | API 监听地址                       |
| `PUBLIC_BASE_URL`           | -                       | 公开访问地址，用于生成支付回调 URL |
| `DATABASE_URL`              | -                       | PostgreSQL 连接地址                |
| `REDIS_URL`                 | -                       | Redis 连接地址                     |
| `JWT_SECRET`                | -                       | JWT 签名密钥，必须是强随机值       |
| `MANAGER_KEY`               | -                       | 管理后台认证密钥，提供时必须强随机 |
| `ALLOWED_ORIGINS`           | -                       | 生产环境 CORS 白名单               |
| `LOCAL_AGENT_ENTRY_MODE`    | `auto`                  | 本地 agent-runner 入口选择：`auto` / `src` / `dist` |
| `BILLING_RESERVATION_STALE_MS` | `2400000`            | 预留计费请求的陈旧判定时长         |
| `TRACE_RETENTION_DAYS`      | `7`                     | `conversation_logs.trace_events` 保留天数 |

模型 Provider 当前主要通过管理后台 `/api/admin/system-config` 写入数据库；AI 请求消费宿主下发的 `llmRuntime`，不依赖进程级模型密钥。
