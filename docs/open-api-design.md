# FateClaw 对外开放 API 设计文档

> 状态：设计草案（待 review）
> 目标读者：FateClaw 内部研发；后续将派生出面向第三方开发者的对外文档。
> 关联代码：`apps/api`（HTTP/鉴权/计费）、`apps/agent-runtime`（Agent 运行时）、`packages/contracts`（对外契约）。

## 1. 背景与目标

为会员提供**程序化调用能力**，让第三方系统（用户自己的应用、自动化脚本等）通过 API Key 调用 FateClaw 的两类能力：

1. **排盘 API** —— 调用 7 种确定性排盘（八字 / 六爻 / 经占 / 梅花 / 奇门 / 六壬 / 紫微），输入生辰或起卦参数，返回结构化盘面 + AI 可读文本。
2. **Agent API** —— OpenAI 兼容的对话补全接口，把"用户提示词 + 开启的 skill + 模型 + 思考等级"交给 FateClaw Agent 运行时执行，按 token 计费。

### 核心决策（已拍板）

| 维度 | 决策 | 理由 |
|---|---|---|
| 本轮产出 | 设计文档 + 骨架代码 | 文档先行 review，再落地迁移/鉴权/路由骨架 |
| Agent 形态 | **OpenAI 兼容** `/api/v1/chat/completions` | 第三方可直接用 OpenAI SDK 改 `base_url` 调用，迁移成本最低；FateClaw 特性走 `fateclaw` 扩展字段 |
| 计费 / 模型 | **仅平台官方模型，按 token 扣 coins** | 不做 BYOK，直接复用现有 metered 结算链路，设计大幅简化 |
| Key 权限 | **单一全权 key** | 一个 key 调排盘 + Agent，无 scope 分支；后续可平滑加 scope |
| 生成 key 门槛 | **会员（`fateclaw_clarity`）才能生成** | 复用 `hasPaidMembershipEntitlement()` |

## 2. 设计原则

1. **复用优先，不另起炉灶**：排盘 runner、Agent 运行时、token 计费、会员门控均已存在，对外 API 只新增"鉴权 + 边界 + 桥接"薄层。
2. **对外路由统一前缀 `/api/v1`**：放在全站 `/api/*` 之下（而非顶层 `/v1`），天然走现有 dev 代理与生产反代规则、无需额外路由配置；用独立的 `v1` 版本段与内部 `/api/<域>` 区隔、避免污染站内接口，同时契合 OpenAI SDK 的 `base_url` 约定。
3. **延续既有约定**：对外 contract 用 `snake_case`（转换只在 `contracts-adapter`）、密钥永不回显明文（只给前缀 + 后 4 位）、Redis 限流、`trustProxy` 还原真实 IP。
4. **错误体的唯一例外**：`/api/v1/chat/completions` 必须返回 **OpenAI 风格错误体**（否则 OpenAI SDK 无法解析报错），因此整个 `/api/v1` 对外域统一采用 OpenAI 风格错误体，与内部 `/api` 的 `{ "error": "中文" }` 区分（见 §9）。
5. **Key 挂在 `user` 上**，不挂 `account`（`account` 是已停用的微信 bot 实体）。

## 3. 架构总览

```
                         第三方调用方
                              │  Authorization: Bearer fc_live_xxx
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/api (Fastify)                                           │
│                                                              │
│  /api/v1/* 对外域   ──requireApiKey()──┐                          │
│   ├─ GET  /api/v1/paipan/catalog       │ 解析 key → sha256 → 查表 │
│   ├─ POST /api/v1/paipan/{type}        │ 校验 status/expires      │
│   └─ POST /api/v1/chat/completions     │ 校验会员有效 + 未欠费     │
│                                    │ request.user = {userId}  │
│  /api/api-keys 管理域 ──requireAuth()(站内 JWT)               │
│   ├─ POST   生成 (会员校验, 明文返回一次)                      │
│   ├─ GET    列出 (脱敏)                                       │
│   └─ DELETE 吊销                                              │
└───────┬───────────────────────────────┬─────────────────────┘
        │ 排盘：进程内纯函数              │ Agent：跨进程异步
        ▼                               ▼
  paipan runner (纯函数)         Redis IPC  ipc:{accountId}:inbox
  validateDirectPaipanInput      ───────────────────────────────┐
  → { data, text }                                              ▼
  零计费 + 限流                          apps/agent-runtime (常驻进程)
                                         executeContainerInput()
                                         流式 → ipc:ai-chat:stream:{sessionId}
                                         ◀──── usage ────┐
                                                         │
   reserve/settle 计费 (复用 modules/billing) ◀──────────┘
```

**两条数据通路的根本差异**：
- **排盘**是进程内纯函数调用，同步、确定性、零计费。
- **Agent** 底层是按账号隔离的 Redis-IPC 异步守护进程（站内聊天是「入队 → `request_id` → WebSocket 推流」模型），对外 OpenAI 兼容接口需要把它**桥接**成同步 JSON 或 SSE 流（见 §7.4）。

## 4. 鉴权层：API Key 体系（全新建）

> 现状：系统**不存在**平台颁发型 api-key。现有所有 `api_key` 都是 BYOK（用户填的第三方 provider 密钥）。本层为全新建，但鉴权范式直接照搬 `admin-routes` 的「读 header 凭据 → 解析 principal → 写 request 装饰字段 → 失败指数退避」。

### 4.1 Key 格式

```
fc_live_<43 位 base62 随机串>
└─┬──┘ └──────────┬──────────┘
 前缀          密钥主体（仅生成时明文返回一次）
```

- 前缀 `fc_live_` 用于环境识别（未来可加 `fc_test_`）。
- 主体用 `crypto.randomBytes(32)` → base62，足够熵。
- **只存哈希**：`key_hash = sha256(完整明文)`（复用 `system-config.ts` 已有的哈希工具风格）。
- 脱敏展示：`key_prefix`（`fc_live_`）+ `last_four`（后 4 位），复用 `apiKeyPreview()` 范式。

### 4.2 数据表 `user_api_keys`（迁移 0066）

```sql
CREATE TABLE IF NOT EXISTS user_api_keys (
  id           TEXT PRIMARY KEY,                         -- uuid
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                            -- 用户起的名字，便于区分
  key_prefix   TEXT NOT NULL,                            -- 'fc_live_'
  key_hash     TEXT NOT NULL UNIQUE,                     -- sha256(明文)，鉴权查这个
  last_four    TEXT NOT NULL,                            -- 脱敏展示
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','revoked')),
  expires_at   TIMESTAMPTZ,                              -- 可空，NULL=永不过期
  last_used_at TIMESTAMPTZ,                              -- 节流更新（见 4.4）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_active
  ON user_api_keys (user_id) WHERE status = 'active';
```

- 迁移遵循现有约定：在 `definitions/` 下新建 `0066-user-api-keys.ts`，导出 `readonly DatabaseMigration[]`，在 `definitions.ts` 末尾**追加**（只追加不重排）；用 `CREATE TABLE IF NOT EXISTS` 等幂等写法。
- 每用户 key 数量上限：建议 **10**（在路由层 `MAX_API_KEYS_PER_USER` 常量校验，不加 DB 约束，便于调）。

### 4.3 Key 管理路由（站内，JWT 鉴权）

挂在内部 `/api/api-keys`，用现有 `request.requireAuth()`（用户在网页端登录态下管理自己的 key）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/api-keys` | **生成**。前置 `hasPaidMembershipEntitlement()` 会员校验；body `{ name, expires_at? }`；响应**仅此一次**返回明文 `key`，之后无法再取 |
| `GET` | `/api/api-keys` | **列出**自己的 key（脱敏：`id/name/key_prefix/last_four/status/last_used_at/created_at/expires_at`） |
| `DELETE` | `/api/api-keys/:id` | **吊销**（`status='revoked'`, `revoked_at=NOW()`），校验 key 归属当前用户 |

### 4.4 鉴权中间件 `requireApiKey()`

对外 `/api/v1/*` 路由前置（仿 `admin-routes` 的 `onRequest` hook）：

```
1. IP 失败退避检查（rateLimitCheck）：超限 → 429 + Retry-After
2. 从 Authorization: Bearer fc_live_xxx 解析（缺失/格式错 → rateLimitRecordFail → 401）
3. sha256(明文) → 查 user_api_keys WHERE key_hash = ? AND status='active'
   未命中 → rateLimitRecordFail(防爆破) → 401
4. 过期校验（expires_at 非空且已过）→ 401
5. 按 key 维度限流 fixedWindowRateLimit(`openapi:{keyId}`)：超限 → 429
   ⚠️ 上移到会员/欠费之前——持合法 key 但欠费/会员过期者同样被限流，
   否则可零限流地反复触发下一步昂贵的权益快照写事务（已鉴权 DoS）
6. getRuntimeEntitlementSnapshot(userId)：
   !hasPaidMembership → 403（key 不物理失效，续费即恢复，见 §10 决策点）
   wallet.inArrears   → 402
7. 写 request.apiKeyPrincipal = { userId, apiKeyId, keyName }
   rateLimitClear（清 IP 退避）+ 节流更新 last_used_at（Redis 标记，最多每 60s 写库）
```

> 设计要点：鉴权后只写 `request.apiKeyPrincipal`，**不**伪造 JWT 的 `request.user`；各 /api/v1 路由显式取 `principal.userId` 传给下游（`executeDirectPaipan` / `dispatchAiChatPrompt` / `getRuntimeEntitlementSnapshot`）。这样既复用了以 userId 为主体的现成逻辑，又不与 JWT 鉴权语义混淆。

## 5. 路由前缀与版本约定

| 域 | 前缀 | 鉴权 | 错误体 |
|---|---|---|---|
| 对外开放 API | `/api/v1/*` | `requireApiKey()` | OpenAI 风格 |
| Key 管理 | `/api/api-keys` | 站内 JWT | 项目统一 `{error:"中文"}` |
| 内部既有 | `/api/<域>` | JWT / X-Admin-Key | 项目统一 |

OpenAI SDK 用法：`base_url = https://<host>/api/v1`，SDK 自动拼成 `/api/v1/chat/completions`。

## 6. 排盘 API

### 6.1 `GET /api/v1/paipan/catalog`

返回所有对外可用排盘类型及其参数 JSON-Schema（复用 `listDirectPaipanCatalog` / `PAIPAN_REGISTRY_CONFIG`）。

```jsonc
{
  "paipan_types": [
    {
      "type": "bazi",                 // 对外用短名，内部映射 bazi-paipan
      "name": "八字排盘",
      "description": "...",
      "parameters": { /* JSON-Schema */ },
      "examples": [ /* ... */ ]
    }
    // ... iching / jingzhan / meihua / qimen / liuren / ziwei
  ]
}
```

### 6.2 `POST /api/v1/paipan/{type}`

`type` ∈ `bazi | iching | jingzhan | meihua | qimen | liuren | ziwei`（对外短名 → 内部 registry key `*-paipan`）。

请求体 = 该排盘的参数（直接对应 registry schema）。复用 `validateDirectPaipanInput`（校验 + 填默认值），再调对应 runner 纯函数，**跳过** preview/commit/会话/Redis/客户预填那一整套站内逻辑。

```jsonc
// POST /api/v1/paipan/bazi
{
  "solar_date": "1990-05-20",   // 对外 snake_case；内部映射 solarDate
  "hour": 14,
  "gender": "男",
  "include": ["bazi", "fortune", "pattern"]
}
```

响应：

```jsonc
{
  "type": "bazi",
  "text": "公历 1990 年 5 月 20 日……八字：庚午 辛巳 ……",  // formatOfficialPaipan，AI 可读
  "data": { /* 结构化盘面 artifactData，跟随底层算法库版本 */ }
}
```

> **输出契约稳定性提醒**：`data` 是底层算法库（`bazi-ts-lib` 等）的原始 shape，会随库版本变化。MVP 同时返回 `text`（稳定）+ `data`（结构化但可能变动）。对外文档需声明 `data` 的版本耦合性，或后续封一层稳定 DTO（列为决策点 §10）。

### 6.3 各排盘输入参数（对外 snake_case）

| type | 必填 | 关键可选参数 |
|---|---|---|
| `bazi` 八字 | `solar_date`, `hour`, `gender` | `minute`, `zishi_mode(early/late)`, `child_limit_mode`, `include[bazi/fortune/pattern]` |
| `ziwei` 紫微 | `solar_date`, `hour`, `gender` | `minute`, `fix_leap`, `day_divide`, `year_divide`, `horoscope{...}` |
| `iching` 六爻 / `jingzhan` 经占 | （无）| `method(dayan/lueshifa/manual/three/array/time)`, `yao`(manual 必填), `numbers`, `datetime` |
| `meihua` 梅花 | 视 `method` | `method(time/counts/trigrams)`；counts→`upper`+`lower`；trigrams→`upper_trigram`+`lower_trigram`+`moving_line` |
| `qimen` 奇门 | （无，默认当前时间）| `solar_date`+`hour` 必须同传同不传 |
| `liuren` 大六壬 | （无）| `time_mode(now/custom/random)`, `solar_date`, `hour`, `random_number` |

> 注：当前所有 runner **均不消费经纬度 / 出生地**，不做真太阳时校正（决策点 §10）。

### 6.4 计费与限流

- **零 coins 计费**（与站内排盘一致，确定性计算）。
- 受 api-key 维度限流约束（§8），防滥用。
- 未来若要对排盘按次计费，在路由层加一道 reserve/settle 即可（预留扩展点）。

## 7. Agent API（OpenAI 兼容）

### 7.1 `POST /api/v1/chat/completions`

OpenAI Chat Completions 兼容。第三方用标准 OpenAI SDK 改 `base_url` 即可调用；FateClaw 特性通过 `fateclaw` 扩展字段表达（OpenAI SDK 用 `extra_body` 传递）。

### 7.2 请求体

```jsonc
{
  "model": "<official_models.model_key>", // MVP 直传内部 model_key；稳定别名 fateclaw-pro 待实现（见 §7.3）
  "messages": [
    { "role": "system", "content": "你是一位命理师" },
    { "role": "user", "content": "帮我解读这个八字" }
  ],
  "stream": false,                    // false=同步 JSON；true=SSE 流
  "max_tokens": 2048,                 // → llmRuntime.maxOutputTokens

  "fateclaw": {                       // FateClaw 扩展字段（非 OpenAI 标准）
    "skills": ["<skill-uuid>", "..."],// 开启的 skill，用 skill id(UUID)
    "thinking_level": "high",         // off|minimal|low|medium|high|xhigh，默认 medium
    "board": {                        // 可选：排盘结果（解读场景）
      "type": "bazi",
      "data": { /* 来自 /api/v1/paipan/bazi 的 data */ },
      "text": "..."
    }
  }
}
```

**字段映射到 `ContainerInput`**：

| OpenAI / 扩展字段 | → ContainerInput | 备注 |
|---|---|---|
| `messages` 中最后一条 user 内容 | `userMessage` | 之前的轮次→ `history`，多轮映射见 §7.4 |
| `fateclaw.skills` | `authorizedSkillIds` | 按单个 skill id 授权，见 §7.6 |
| `fateclaw.thinking_level` | `llmRuntime.thinkingLevel` | 枚举一致，可直接透传 |
| `model` | `llmRuntime.model` 等 | 经别名映射，见 §7.3 |
| `max_tokens` | `llmRuntime.maxOutputTokens` | |
| `fateclaw.board` | `pastedBoard` (`inputKind:'user_pasted_board'`) | 对外无 session，用 pasted 形态注入 |

### 7.3 模型映射

- **MVP（当前骨架）**：对外 `model` 字段**直接传内部 `official_models.model_key`**。`resolveOfficialRuntimeByModelKey(model_key, thinking_level)` 精确匹配并构造 `source='official'` + `billingMode='metered'` 的运行时（带 `input/output_token_price_per_million_coins`）。未知/不可用 model → 400。
- **稳定别名（待实现，见 §10 决策点 7）**：未来加 `official_models.public_alias` 列或映射表，对外暴露 `fateclaw-pro` 这类稳定别名以解耦内部标识；届时 §7.2 示例的 `fateclaw-pro` 才生效。当前请用 `GET /api/v1/models` 返回的 `model_key`。
- `GET /api/v1/models`（OpenAI 兼容）列出当前可用的官方 `model_key`（部分 SDK 会探测）。

### 7.4 核心难点：异步 Redis-IPC → 同步/SSE 桥接

agent-runtime 是按账号隔离的常驻进程，站内通过 Redis IPC 通信。对外同步/SSE 接口的桥接流程：

> 实现关键：无需手写 enqueue/listener/计费 —— 高层入口 `dispatchAiChatPrompt()`（resident-agent.ts）已封装保活 + 监听 + reserve/settle 计费 + 等 final。

```
1. accountId = getWebChatRuntimeId(userId) = web:{userId}
   （对外调用与站内共用同一 resident 进程，不新增进程）
2. 构造 dispatchAiChatPrompt 入参（§7.2 映射）：
   - userMessage      ← messages 末条 user
   - history          ← 末条 user 之前的 user/assistant 轮（排除 system、空内容；见 §7.8）
   - personaPrompt    ← 第一条 system 消息
   - pastedBoard      ← fateclaw.board（inputKind:'user_pasted_board'）
   - authorizedSkillIds ← fateclaw.skills（按单个 skill id 授权，见 §7.6）
   - llmRuntime       ← resolveOfficialRuntimeByModelKey(model, thinking_level)（强制 official metered）
   - entitlementSnapshot ← getRuntimeEntitlementSnapshot(userId)
   - sessionId        ← 一次性 openapi:{uuid}（对外每次调用独立会话）
3. 调 dispatchAiChatPrompt(...)：内部已完成
   ensureLocalAgentRunning（保活）+ addAccountListener + reserve/settle 计费 + 等 final。
   ⚠️ 对外路由绝不重复 reserve/settle，否则双重计费。

   ┌─ stream=false（同步）──────────────────────────────────┐
   │ waitForResponse:true → 取 InboxRequestResult.text       │
   │ → 翻译成 OpenAI ChatCompletion JSON                     │
   └────────────────────────────────────────────────────────┘
   ┌─ stream=true（SSE）────────────────────────────────────┐
   │ 先 SUBSCRIBE aiChatStreamChannel(sessionId) 再 dispatch │
   │ (waitForResponse:false)，避免漏早期 assistant_delta；    │
   │ assistant_delta → content chunk，final → finish_reason  │
   │ (+ 可选 usage chunk)，收尾 data: [DONE]；断连 cancel。  │
   └────────────────────────────────────────────────────────┘
4. usage：dispatchAiChatPrompt 经 IPC 回传 InboxRequestResult.usage
   （normalizeRuntimeTokenUsage 归一化，与计费同口径）；provider 未上报时回退 0。
```

### 7.5 非流式响应（`stream: false`）

```jsonc
{
  "id": "chatcmpl-<requestId>",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "fateclaw-pro",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "你的八字……" },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 1234,        // = promptTokens（含 cacheRead/Write 折入）
    "completion_tokens": 567,
    "total_tokens": 1801
  }
}
```

> `usage` 为真实 token 数：由 `dispatchAiChatPrompt` 经 IPC 回传（`InboxRequestResult.usage`，`normalizeRuntimeTokenUsage` 归一化，与计费同口径）。provider 未上报用量时三项回退 0。流式下需 `stream_options.include_usage=true` 才在末尾追加 usage chunk（OpenAI 约定）。

### 7.6 skill 注入（需小改动）

`fateclaw.skills` 用 **skill id(UUID)** —— skill 的唯一稳定标识（`dir_name` 可变、`skill_name` 不唯一）。

**按单个 skill id 授权**（已实现）：
- `apps/agent-runtime/src/agent-db.ts`：`queryEffectiveUserSkillsByIds(userId, skillIds)` 复用 `queryEffectiveUserSkills` 的归属/订阅/`enabled` 校验后按 id 过滤。
- `ContainerInput` / `ChatTaskInboxRequest` 增 `authorizedSkillIds?: string[]`；`resource-loader.ts` 经 `listEffectiveUserSkillsByIds` 走 by-id 分支（`hasExplicitSkillBundleScope` 也认这个字段）。
- 取值约束：只放行「调用方自有 enabled + active 订阅且 enabled」的 skill id；无权/未启用的 id 在 runtime 内**静默丢弃**（不报错）。

> token 影响：开启更多 skill 仅让 system prompt 多几行索引（小）；真正计费大头是模型用 read/grep 把 skill 正文读进对话后计入后续 `promptTokens`。属正常 token 计费，无需额外定价。

### 7.8 多轮历史映射（真·按角色注入）

对外是 **OpenAI 无状态语义**：服务端不存历史，上下文完全由本次 `messages` 决定。但内部 runtime 走「一次性 `sessionId`」、每次调用独立会话，因此需把 `messages` 里的历史轮**主动注入**会话上下文：

- **路由层**（`open-chat-routes.ts`）：定位最后一条 `user`（本轮 prompt），取其**之前**的 `user`/`assistant` 轮为 `history`（排除 `system`——已并入 `personaPrompt`——与空内容，保持原顺序）。
- **runtime 层**（`pi-runtime/session.ts`）：`createAgentSession` 之前，按真实角色 `SessionManager.appendMessage()` 把 `history` 逐条写入会话树（`user` → `UserMessage`；`assistant` → `AssistantMessage`，其 api/provider/model 取 `llmRuntime`，`usage` 置零、`stopReason:'stop'`，仅本地记账、不回传 provider）。createAgentSession 经 `buildSessionContext` 一次性读取，故**必须先注入再创建**。
- Web 内部多轮走持久化 `sessionId`，`history` 恒为空、跳过该分支，互不影响。

### 7.7 计费

计费**完全由 `dispatchAiChatPrompt` 内部链路完成**：reserve（入口校验欠费）→ 执行 → 按真实 usage `settleBillingReservationDetailed` 扣 coins（`promptTokens*inputPrice/1M + completionTokens*outputPrice/1M`，`roundCoinsToCents`）→ `incrementDailyTokens` → sweeper 兜底；口径与站内 AI Chat 完全一致。

> ⚠️ **对外路由绝不重复 reserve/settle**，否则双重计费。对外只需用 `resolveOfficialRuntimeByModelKey` 构造 `source='official'` + `billingMode='metered'` 的 `llmRuntime` 传入，计费即自然发生（BYOK/custom 会被短路为 0，故必须强制官方模型）。

**新增 api_key 维度**：MVP 把 `apiKeyId` 塞进 `billing_request_reservations.metadata`（jsonb，现成透传）。若需 per-key 可查询报表，再给 `billing_request_reservations` / `daily_usage` 加 `api_key_id` 列（列为决策点 §10）。

## 8. 限流与配额

- 按 api-key 维度：`fixedWindowRateLimit('openapi:{apiKeyId}', limit, 60)`（复用现成限流器，Redis 故障 fail-open）。
- MVP 统一额度（如 60 次/分钟）；后续可按会员档/key 分级。
- `429` 返回 `Retry-After` 头。
- Agent 调用受 token 余额自然约束（欠费即拒绝起请求）。

## 9. 错误格式（`/api/v1` 域 = OpenAI 风格）

```jsonc
{
  "error": {
    "message": "API Key 无效或已吊销",   // 可中文
    "type": "invalid_request_error",      // OpenAI 错误类型
    "code": "invalid_api_key",            // 机器可读
    "param": null
  }
}
```

| 状态码 | 场景 | type / code |
|---|---|---|
| 401 | key 缺失/无效/吊销/过期 | `invalid_request_error` / `invalid_api_key` |
| 402/403 | 会员过期 / 钱包欠费 | `insufficient_quota` / `membership_required` |
| 400 | 参数错误（排盘 schema 不过、未知 model） | `invalid_request_error` |
| 429 | 限流 | `rate_limit_exceeded` |
| 500/503 | 服务/上游错误 | `api_error` |

> 内部 `/api/api-keys` 管理路由仍用项目统一 `{ "error": "中文" }`。

## 10. 决策点

### 10.1 已定（已拍板，代码即此实现）

- **排盘对外零计费**：仅按 key 维度限流，不走 reserve/settle（保留扩展点，未来如需可改按次计费）。
- **会员过期后 key 续费恢复**：调用时校验会员有效，过期返 403 但 **key 不物理失效**，续费即恢复（`api-key-auth.ts`）。
- **model 用内部 `model_key` 直传**：不做 `fateclaw-pro` 别名层；调用方用 `GET /api/v1/models` 返回的 `model_key`。未来如需解耦再加 `public_alias`。
- **限流统一 60 次/分钟/key**：单层会员（`fateclaw_clarity`）下不存在会员档分级；未来若引入多档会员或需 per-key 自定义额度再扩展。

### 10.2 保持默认（未特别指定，沿用合理默认，后续可调）

- **`data` 结构化输出**：透传底层库原始 shape（标注版本耦合）；未来如需对外稳定性可封一层 DTO。
- **真太阳时 / 出生地**：runner 不消费经纬度，暂不做。
- **per-key 计费报表**：先用 `billing_request_reservations.metadata` 透传 `apiKeyId`；如需可查询报表再加 `api_key_id` 列。
- **每用户 key 上限**：10（`MAX_API_KEYS_PER_USER`，路由层校验）。

## 11. 骨架代码清单（本轮落地）

| # | 文件 | 内容 |
|---|---|---|
| 1 | `apps/api/src/infrastructure/migrations/definitions/0066-user-api-keys.ts` | `user_api_keys` 表迁移（幂等），并在 `definitions.ts` 追加 |
| 2 | `apps/api/src/infrastructure/repositories/api-keys-repository.ts` | `create / listByUser / findByHash / revoke / touchLastUsed` |
| 3 | `packages/contracts/src/api-keys/index.ts` | 对外/管理 DTO（snake_case） |
| 4 | `apps/api/src/interfaces/http/api-key-auth.ts` | `requireApiKey()` 中间件（仿 admin 范式） |
| 5 | `apps/api/src/interfaces/http/api-keys-routes.ts` | `/api/api-keys` 管理路由（站内 JWT） |
| 6 | `apps/api/src/interfaces/http/open-paipan-routes.ts` | `/api/v1/paipan/catalog` + `/api/v1/paipan/{type}` |
| 7 | `apps/api/src/interfaces/http/open-chat-routes.ts` | `/api/v1/chat/completions`（OpenAI 兼容 + IPC 桥接：真实 usage 回填 / 多轮历史 / SSE 流式 / 单 skill 授权均已接线） |
| 8 | `apps/api/src/interfaces/http/server.ts` | 注册以上路由 |
| 9 | `apps/agent-runtime` `agent-db.ts` / `resource-loader.ts` / `ContainerInput` | 新增 `authorizedSkillIds` 按 skill id 过滤（§7.6） |
| 10 | `apps/agent-runtime/src/pi-runtime/session.ts` | 多轮历史按角色注入会话上下文（§7.8） |

落地范围：鉴权链路 + 排盘端点接线跑通；Agent 桥接四项集成（usage 回填 / 多轮历史 / SSE 流式 / 单 skill 粒度授权）已全部实现，详见 §7.4 / §7.6 / §7.8。

## 12. 实施步骤

```
1. 迁移 0066 + repository           → verify: 迁移幂等执行、表结构正确
2. contracts DTO                    → verify: tsc 通过
3. requireApiKey() 中间件           → verify: 无 key/坏 key/过期 各分支返回正确
4. /api/api-keys 管理路由           → verify: 生成→列出→吊销 闭环，明文仅一次
5. /api/v1/paipan/*                     → verify: 用真实 key curl 出八字盘面
6. /api/v1/chat/completions 桥接        → verify: stream=false/true 各跑通一次
7. 更新 docs/api-reference.md       → 同步对外 API 说明
8. workflow 多维度审查骨架          → 一致性/鉴权/接线/遗漏
```
