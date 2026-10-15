# FateClaw API Reference

> Base URL: `http://localhost:3000`（可通过 `API_PORT` 环境变量修改）

## 路由清单

当前 Fastify 装配的 API 前缀：

- `/api/auth`
- `/api/account`
- `/api/chat-sessions`
- `/api/messages`
- `/api/model-settings`
- `/api/paipan`
- `/api/referrals`
- `/api/skills`
- `/api/billing`
- `/api/api-keys`
- `/api/v1`
- `/api/admin`
- `/api/health`
- `/api/ready`

## 运行模式速记

当前稳定主链路是站内 AI Chat、手动排盘和 Text Skill Bundle 知识库。微信 OpenClaw/iLink 已整体可逆停用（`WECHAT_CLAW_FEATURE_ENABLED=false` + 迁移 0057），`canUseWechatClaw` 恒为 `false`，相关扫码绑定与轮询/发送链路恒不可用。

- AI Chat 请求会由 API 写入用户消息、解析请求级 `llmRuntime`、抢占会话 busy 锁，再通过 Redis IPC 投递到 `web:{userId}` 对应的本地 agent-runtime。
- `POST /api/chat-sessions/s/:sessionId/messages` 通常只表示请求已入队；最终 assistant 消息由 `ipc:{runtimeId}:ai-chat:outbox` handler 异步落库、结算并通过 WebSocket 推送。
- 手动排盘不调用模型。API 侧直接执行 `paipan-runners/*.ts`，把结构化盘面作为 `tool_context/artifactData` 写入会话。
- Text Skill Bundle 正文写在 `.fateclaw/text-skills` 文件系统目录，数据库只保存 metadata、权限、版本和 `bundle_uri`。agent-runtime 每轮只读取本次请求授权的 Bundle。

## 认证

除明确标注为公开接口的路由外，业务接口需要在请求头中携带 JWT。公开接口包括图形验证码、登录注册/找回密码、分享预览、排盘 catalog/preview、公开市场、邀请预览、状态页、支付通知和健康检查。

```
Authorization: Bearer <token>
```

---

## Auth 认证

当前认证路由还包含：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/captcha` | 获取图形验证码挑战 |
| POST | `/api/auth/me/send-sms-captcha` | 登录用户发送换绑/重置类短信验证码 |
| POST | `/api/auth/change-password` | 登录用户修改密码 |
| POST | `/api/auth/reset-password` | 未登录找回密码 |
| POST | `/api/auth/me/reset-password` | 登录用户重置自己的密码 |

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
| password       | string | 是   | 至少 8 位          |
| smsCaptchaCode | string | 是   | 短信验证码         |

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

账号管理接口均需认证。微信 OpenClaw/iLink 已整体可逆停用（`WECHAT_CLAW_FEATURE_ENABLED=false` + 迁移 0057），`canUseWechatClaw` 恒为 `false`，扫码绑定、状态轮询和发送链路恒不可用；下列接口仍在路由表中注册，但在停用开关下不会真正生效。

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

### 其他账号接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/account/me/soul` | 读取当前用户级 Soul 自定义人格 |
| PUT | `/api/account/me/soul` | 更新当前用户级 Soul 自定义人格，传 `{ "content": "..." }` |
| GET | `/api/account/:id/soul` | 读取指定账号 Soul |
| PUT | `/api/account/:id/soul` | 更新指定账号 Soul，传 `{ "content": "..." }` |
| DELETE | `/api/account/:id` | 解除并删除当前用户拥有的账号 |
| POST | `/api/account/qrcode` | 请求 iLink 扫码绑定二维码 |
| POST | `/api/account/qrcode/status` | 轮询二维码状态，传 `{ "qrcode": "..." }` |

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
| before | string | - | 游标时间，返回该时间之前的消息 |

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

除分享预览外，以下接口均需认证，只能访问当前用户自己的会话。

| 方法   | 路径                                                                 | 说明                       |
| ------ | -------------------------------------------------------------------- | -------------------------- |
| GET    | `/api/chat-sessions`                                                 | 列出站内 AI Chat 会话      |
| GET    | `/api/chat-sessions/archived`                                        | 列出已归档会话             |
| POST   | `/api/chat-sessions`                                                 | 创建会话，可传 `{ "title": "..." }` |
| PATCH  | `/api/chat-sessions/s/:sessionId`                                    | 更新会话标题               |
| DELETE | `/api/chat-sessions/s/:sessionId`                                    | 归档会话并清理本地 Pi session 文件 |
| POST   | `/api/chat-sessions/s/:sessionId/restore`                            | 恢复已归档会话             |
| POST   | `/api/chat-sessions/s/:sessionId/share`                              | 生成或复用会话私密分享链接 |
| GET    | `/api/chat-sessions/shared/:token`                                   | 通过分享令牌只读查看会话，无需认证 |
| GET    | `/api/chat-sessions/s/:sessionId/messages`                           | 获取消息，支持 `limit` 和 `before` |
| POST   | `/api/chat-sessions/s/:sessionId/messages`                           | 发送消息，传 `content` 和可选 `selected_board_message_id` |
| POST   | `/api/chat-sessions/s/:sessionId/messages/cancel`                    | 中断当前会话正在处理的 AI Chat 输出 |
| POST   | `/api/chat-sessions/s/:sessionId/stream-ticket`                      | 签发一次性 WebSocket stream ticket |
| GET    | `/api/chat-sessions/s/:sessionId/messages/:messageId/query-process`  | 获取脱敏后的查询过程时间线 |

### POST /api/chat-sessions/s/:sessionId/messages

发送一轮站内 AI Chat。服务端会先写入用户消息、解析模型 runtime、构造历史上下文和当前盘面上下文，再异步投递给 `web:{userId}` 对应的 agent-runtime。

**Request Body**

普通消息：

```json
{
  "content": "这个盘面怎么看事业？",
  "selected_board_message_id": "paipan-res-...",
  "input_kind": "normal"
}
```

自贴盘面：

```json
{
  "input_kind": "user_pasted_board",
  "pasted_board": {
    "category": "bazi",
    "content": "用户粘贴的盘面正文",
    "question": "请看事业方向"
  }
}
```

**Response 200**

异步模式下通常返回：

```json
{
  "text": "",
  "accepted": true,
  "request_id": "aichat-1770000000000-abcdef",
  "session_title": "八字排盘"
}
```

`accepted: true` 只表示后台已接收请求，不表示最终回复已生成。最终 assistant 消息会由 outbox handler 写入消息表；前端应连接 WebSocket 或轮询消息列表刷新结果。

### AI Chat WebSocket Stream

WebSocket 不能直接复用长期 JWT。前端需要先调用：

```http
POST /api/chat-sessions/s/:sessionId/stream-ticket
Authorization: Bearer <token>
```

响应：

```json
{
  "ticket": "single-use-ticket",
  "expiresAt": "2026-06-14T10:00:00.000Z"
}
```

然后连接：

```text
ws://localhost:3000/api/chat-sessions/s/:sessionId/stream?ticket=single-use-ticket
```

票据有效期 60 秒，单次消费，并绑定当前用户与会话。事件类型包括 `connected`、`agent_start`、`turn_start`、`thinking_delta`、`assistant_delta`、`tool_start`、`tool_update`、`tool_end`、`progress`、`final`、`error` 和 `usage`。

### 会话继续与取消

- 同一会话同一时间只允许一个处理中请求，Redis key 为 `session:processing:{sessionId}`。
- `POST /api/chat-sessions/s/:sessionId/messages/cancel` 会释放 pending、释放并发槽位和本地 agent 租约，并向 `ipc:{runtimeId}:cancel` 写入取消请求。
- 如果会话长期未活跃且本地 Pi session 文件缺失，消息列表会返回 `continuation_blocked`，前端应阻止继续追问并提示用户新建对话。

---

## Paipan 纯排盘

纯排盘接口由 API 进程调用内部 TypeScript runner 并返回结构化 `skillContext`。预览请求不写入会话，也不需要模型 `llmRuntime`。

| 方法 | 路径                  | 说明                                               |
| ---- | --------------------- | -------------------------------------------------- |
| GET  | `/api/paipan/catalog` | 公共接口，列出可直接排盘的系统排盘项               |
| POST | `/api/paipan/preview` | 公共接口，传 `skill` 和 `input` 执行预览，不写入会话；携带有效 JWT 时会带入用户上下文 |
| POST | `/api/paipan/commit`  | 需认证，把预览或即时排盘结果提交到 AI Chat        |

`commit.target` 支持 `new_session_from_preview` 和 `current_session`。提交到当前会话时传 `sessionId`；也可以直接传 `skill` + `input` 让服务端即时排盘并写入。

当前内置系统排盘目录由 `apps/api/src/modules/chat/paipan-registry.ts` 维护，常见 `skill` 值包括：

- `bazi-paipan`：八字排盘
- `ziwei-paipan`：紫微斗数排盘
- `qimen-paipan`：奇门遁甲排盘
- `iching-paipan`：六爻纳甲排盘
- `jingzhan-paipan`：周易经占排盘
- `meihua-paipan`：梅花易数排盘
- `liuren-paipan`：大六壬排盘

`preview` 响应中的 `skillContextEntry` 会包含：

```json
{
  "previewId": "uuid",
  "skillContextEntry": {
    "skill": "bazi-paipan",
    "output": "格式化后的盘面摘要",
    "artifactType": "skill.bazi-paipan",
    "artifactTitle": "八字排盘",
    "artifactData": {}
  },
  "expiresAt": "2026-06-14T10:30:00.000Z"
}
```

`artifactData` 是结构化盘面数据，提交到会话后会保存在消息 `tool_context` 中，后续 AI Chat 会把它作为盘面上下文，而不是重新排盘。

---

## Model Settings

All users use the single official model and thinking level configured by the platform. Model settings are read-only for users.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/model-settings` | Authenticated overview: `{ "model": { ... } }`, or `{ "model": null }` before configuration |

The response contains the model name, availability, description, and input/output token prices. It does not expose provider connection details or credential metadata. User custom-model and selection endpoints are removed.

## Skills 商店与创作者

`/api/skills` 当前只承载用户 Text Skill Bundle、Bundle 组合、市场和授权邀请。系统排盘目录不在这里维护：普通用户直接看 `/api/paipan/catalog`，管理端全局开关在 `/api/admin/skills/global`。

Text Skill Bundle 正文写在文件系统 `.fateclaw/text-skills/<owner>/<dir>-<id>/`，数据库只保存 metadata、权限、版本、安装状态、checksum 和 `bundle_uri`。agent-runtime 每轮只读取当前请求授权的 Bundle，不扫描 Pi 全局 Skill 目录。

### 用户自定义 Skill

- `GET /api/skills/user`：列出自有与已订阅 Skill
- `POST /api/skills/user`：创建 Markdown Skill Bundle
- `GET /api/skills/user/:id`：查看详情
- `PUT /api/skills/user/:id`：更新 Markdown Skill Bundle
- `DELETE /api/skills/user/:id`：软删除
- `PATCH /api/skills/user/:id/toggle`：启用或禁用
- `GET /api/skills/limits`：读取当前生效的 Skill Bundle 文件限制，无需认证
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

`GET /api/skills/limits` 响应：

```json
{
  "max_files": 50,
  "max_file_chars": 100000,
  "max_total_chars": 500000,
  "max_zip_bytes": 8388608
}
```

`files` 只能包含安全相对路径下的文本文件，必须包含 `SKILL.md`。文件数量、单文件字符数、总字符数和 ZIP 导入体积限制由后台系统配置控制。响应中的 `skill_name` 与 `description` 从 `SKILL.md` frontmatter 同步。

### Bundle 与市场

- `POST /api/skills/bundles` / `GET /api/skills/bundles`：创建和列出自有 Bundle
- `PUT /api/skills/bundles/:id` / `DELETE /api/skills/bundles/:id`：更新或软删除 Bundle
- `POST /api/skills/bundles/:id/share` / `DELETE /api/skills/bundles/:id/share`：开启或关闭 Bundle 分享
- `POST /api/skills/bundles/:id/publish` / `DELETE /api/skills/bundles/:id/publish`：公开上架或取消公开
- `GET /api/skills/bundles/shared/:token`：预览分享 Bundle，无需认证
- `POST /api/skills/bundles/subscribe/:token`：批量订阅 Bundle
- `DELETE /api/skills/bundles/subscriptions/:bundleId`：取消 Bundle 订阅
- `GET /api/skills/market`：公开 Skill 市场
- `GET /api/skills/bundles/market`：公开 Bundle 市场
- `GET /api/skills/subscriptions/mine`：我的订阅

---

## Referrals 邀请

用户侧邀请接口。邀请预览无需认证，其他接口需认证。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/referrals/me` | 当前用户邀请概览、邀请码和奖励状态 |
| GET | `/api/referrals/invites/:code/preview` | 公开预览邀请码 |
| POST | `/api/referrals/invites/:code/redeem` | 登录后绑定邀请码 |

---

## Billing 钱包与 Token 计费

### GET /api/billing

查询当前用户的钱包余额和本月 Token 计费概览。需认证。

**Response 200**

```json
{
  "monthly_tokens_used": 905000,
  "monthly_charged_coins": 12.5,
  "purchased_coins": 100,
  "bonus_coins": 20,
  "reserved_coins": 0,
  "available_coins": 120,
  "membership": {
    "enabled": true,
    "active": false,
    "plan_key": null,
    "monthly_price_coins": 30,
    "display_price_coins": 30,
    "current_period_start": null,
    "current_period_end": null
  },
  "membership_entitlements": [
    {
      "plan_key": "membership",
      "name": "卦师使用权",
      "effective_start": "2026-06-10T00:00:00.000Z",
      "effective_end": "2026-07-10T00:00:00.000Z",
      "is_current": true
    }
  ],
  "membership_plans": []
}
```

**会员权益时间轴**

`membership.active` is the effective membership state. `membership_entitlements` contains the single stored period when its status is active and its end is in the future; `is_current` identifies whether that period has started. Renewals extend the same membership row. All membership identifiers are `membership`, and configured names take precedence over the default display name 卦师使用权.

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

查询状态页面展示的全站今日统计。无需认证。

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
  "amount_coins": "50.00",
  "pay_type": "alipay"
}
```

**Response 200**

```json
{
  "pay_url": "https://pay.example.com/...",
  "order": {
    "id": "order-uuid",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "trade_id": "rc1770000000000123456",
    "provider": "epay",
    "provider_trade_id": null,
    "pay_type": "alipay",
    "amount_coins": 50,
    "pay_url": "https://pay.example.com/...",
    "status": "pending",
    "paid_at": null,
    "notified_at": null,
    "created_at": "2026-04-27T10:00:00.000Z",
    "updated_at": "2026-04-27T10:00:00.000Z"
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
  "total_recharge_coins": 150,
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
`PUBLIC_API_BASE_URL` / `PUBLIC_WEB_BASE_URL`、兼容变量 `PUBLIC_BASE_URL`
或当前请求域名生成，下单时自动传给易支付。三站点部署时，`notify_url`
应指向 API 站点，`return_url` 应指向 www 站点。

---

### GET /api/billing/transactions

查询当前用户最近钱包流水。需认证。

---

### GET /api/billing/daily-sign-in

查询当前用户每日签到状态。需认证。

---

### POST /api/billing/daily-sign-in

领取每日签到软妹币奖励。需认证。

---

### POST /api/billing/membership/subscribe

Requires authentication. Opens or renews the single membership using the wallet balance. Optional `plan_key` accepts only `membership`; omission selects the same membership. Unsupported identifiers return HTTP 400. Active memberships retain their period anchor and extend the end date by one month.

---

### POST /api/billing/reset

按 scope 软重置当前用户数据。需认证。`scope` 支持 `all`、`messages`、`memories`、`tasks`，默认 `all`。

---

## API Keys 与开放 API

面向「会员用 API Key 程序化调用」：`/api/api-keys` 是站内管理面（JWT 鉴权），用户在此创建、列出、吊销自己的 API Key；`/api/v1` 是对外调用面（API Key 鉴权，OpenAI 兼容的请求/响应与错误体）。完整的鉴权、端点、计费与会话留存设计见 `docs/open-api-design.md`。

| 前缀 | 鉴权 | 说明 |
| --- | --- | --- |
| `/api/api-keys` | JWT | 站内 API Key 管理面：创建、列出、吊销当前用户的 API Key |
| `/api/v1` | API Key | 对外开放 API：OpenAI 兼容入口，会员凭 API Key 程序化调用排盘/Agent |

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
  "status": "ready",
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

---

## Admin 系统配置

> 以下接口均走 `/api/admin/*`，需要在请求头携带 `X-Admin-Key`。
> `MANAGER_KEY` 拥有全部权限；`USER_MANAGER_KEY` 仅允许用户管理和消息模块。

### POST /api/admin/verify

验证管理密钥是否正确，并返回当前后台身份。

**Response**

```json
{
  "success": true,
  "role": "owner",
  "scopes": ["admin:*"],
  "home_path": "/admin/overview"
}
```

### GET /api/admin/stats

读取全局统计数据，可按充值时间范围筛选。

### GET /api/admin/system-config

Returns `{ "model": { ... } | null, "thinking_level": "medium" }` for the sole official model slot. Credential values, previews, fingerprints, runtime policies, platform service fees, and configuration audit logs are not returned.

### GET /api/admin/recharge-config

读取充值配置。响应中的 `notify_url` / `return_url` 是服务端生成的展示值。

### PUT /api/admin/recharge-config

更新充值配置。回调地址由服务端生成，不需要提交。

**Request Body**

```json
{
  "enabled": true,
  "min_coins": "1.00",
  "max_coins": "1000.00",
  "epay_url_prefix": "https://pay.example.com/",
  "epay_platform_id": 1001,
  "epay_merchant_private_key": "-----BEGIN PRIVATE KEY-----...",
  "epay_platform_public_key": "-----BEGIN PUBLIC KEY-----...",
  "epay_merchant_key": "query-secret"
}
```

### GET /api/admin/reward-config

读取每日签到和会员奖励配置。

### PUT /api/admin/reward-config

更新每日签到和会员奖励配置。

### PUT /api/admin/system-config/model

Saves the single official model and platform thinking level atomically. Repeated or concurrent saves update the same slot. There are no add, delete, priority, or default-model controls.

**Request Body**

```json
{
  "pi_api": "openai-responses",
  "base_url": null,
  "model_name": "gpt-4.1",
  "api_key": "<provider-api-key>",
  "context_window_tokens": null,
  "thinking_level": "medium",
  "input_token_price_per_million_coins": 0,
  "output_token_price_per_million_coins": 0
}
```

- `pi_api`: `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`.
- `thinking_level`: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. This applies to all users and Open API sessions on each new turn.
- `api_key`: required for the first configuration; omit or leave blank to preserve the stored credential. Changing protocol requires a new credential.
- `auth_mode`: optional; must match the protocol. Anthropic supports `anthropic_api_key` and `claude_code_oauth_token`.
- `context_window_tokens`: `null` or `0` uses automatic detection; an explicit value must be 8192–2000000.
- Official input/output token prices remain the billing rates. The separate custom-model platform service fee is removed.

Existing installations reuse the configured default official model, or their first existing model if no default was set. The first save fixes that slot as the platform model. Legacy user choices and session thinking levels do not override it. If the configured model is unavailable, requests fail explicitly without switching providers.

The legacy `/system-config/providers`, `/system-config/runtime`, and `/system-config/model-billing` mutation endpoints are removed. Historical rows and credentials are not deleted during migration.

### 其他管理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/users` | 用户列表与用量概览 |
| POST | `/api/admin/users` | 管理员直接创建用户 |
| GET | `/api/admin/users/:id` | 用户详情 |
| GET | `/api/admin/users/:id/transactions` | 用户钱包流水 |
| POST | `/api/admin/users/:id/balance/grant` | 发放赠送余额 |
| POST | `/api/admin/users/:id/balance/adjust` | 调整充值余额 |
| GET | `/api/admin/users/:id/balance/grants` | 用户赠送余额记录 |
| DELETE | `/api/admin/users/:id/logs` | 删除用户对话日志 |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET | `/api/admin/billing/reservations` | 查询预留计费请求 |
| POST | `/api/admin/billing/reconcile` | 对账陈旧预留计费请求 |
| GET | `/api/admin/messages` | 管理端消息检索 |
| GET | `/api/admin/chat-sessions` | 管理端会话检索 |
| POST | `/api/admin/chat-sessions/pi-sessions/cleanup` | 清理 Pi session 文件 |
| GET | `/api/admin/skills/custom` | 管理端自定义 Skill 检索 |
| GET | `/api/admin/skills/global` | 系统排盘全局开关列表 |

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
| `PUBLIC_API_BASE_URL`       | -                       | API 公开访问地址，用于生成支付异步通知 `notify_url` |
| `PUBLIC_WEB_BASE_URL`       | -                       | www 公开访问地址，用于生成支付完成跳转 `return_url` |
| `DATABASE_URL`              | -                       | PostgreSQL 连接地址                |
| `REDIS_URL`                 | -                       | Redis 连接地址                     |
| `JWT_SECRET`                | -                       | JWT 签名密钥，必须是强随机值       |
| `MANAGER_KEY`               | -                       | 管理后台认证密钥，提供时必须强随机 |
| `USER_MANAGER_KEY`          | -                       | 用户管理员密钥，仅开放用户和消息模块，提供时必须强随机 |
| `ALLOWED_ORIGINS`           | -                       | 生产环境 CORS 白名单；三站点部署时需包含 www 和 admin 来源 |
| `NODE_ENV`                  | -                       | 生产环境建议设为 `production`      |
| `LOCAL_AGENT_ENTRY_MODE`    | `auto`                  | 本地 agent-runtime 入口选择：`auto` / `src` / `dist` |
| `LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB` | -               | agent-runtime 子进程 V8 old space 上限，2G 服务器建议 `128` |
| `AGENT_REQUEST_TIMEOUT`     | `1800000`               | 微信 Bot 请求等待 agent 返回的超时时间，单位毫秒 |
| `AI_CHAT_REQUEST_TIMEOUT`   | `1800000`               | 站内 AI Chat 请求等待 agent 返回的超时时间，单位毫秒 |
| `BILLING_RESERVATION_STALE_MS` | `2400000`            | 预留计费请求的陈旧判定时长         |
| `TRACE_RETENTION_DAYS`      | `7`                     | `conversation_log_payloads.trace_events` 保留天数 |
| `FATECLAW_TEXT_SKILLS_DIR`  | `.fateclaw/text-skills` | 用户 Text Skill Bundle 根目录      |
| `FATECLAW_PI_SESSION_DIR`   | -                       | agent-runtime Pi session 文件目录  |
| `LOG_LEVEL`                 | `info`                  | 服务端日志等级                     |
| `LOG_PRETTY`                | 非生产默认开启          | `1` 强制开启 pino-pretty，`0` 强制关闭 |

模型 Provider 当前主要通过管理后台 `/api/admin/system-config` 写入数据库；AI 请求消费宿主下发的 `llmRuntime`，不依赖进程级模型密钥。
Agent 并发槽位、常驻 runtime 上限和空闲回收时间通过管理后台写入 `runtime_config`。
