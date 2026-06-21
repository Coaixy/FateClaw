# FateClaw 卦师自定义工作流设计

日期：2026-06-21

## 背景

历史上做过一版"简易模式 workflow"：由 admin 配置的**单步预设启动器**（选术数 + 默认参数 + 绑 skill + prompt 模板 + 模型策略，用户点一下完成"排盘 → 一轮 AI 解读"）。这套引擎**至今仍在**：

- 后端 `simple-workflow-service.ts` / `simple-workflow-repository.ts` / `simple-workflows-routes.ts`（含测试）。
- admin 配置页 `apps/admin/app/(dashboard)/workflows/page.tsx`。

只有**用户端入口**在转"纯专业排盘"时被删（`simple-mode-workspace.tsx`、web `features/simple-workflows/api.ts`）。

本设计把"工作流"从两个维度升级：

1. **作者从 admin 改为卦师自己**——按 `user_id` 隔离，卦师创建属于自己的工作流。
2. **从单步升级为多步线性流程**——卦师把若干步骤按顺序排好，每步产出喂给下一步。

定位呼应既有原则「**AI 输出必经人工润色**」：工作流不是"全自动 AI 流水线"，而是"**卦师的断卦套路 + AI 当助手 + 人在关键节点接管**"。

## 目标

- 卦师可创建 / 编辑 / 删除属于自己的多步线性工作流（用户隔离）。
- 步骤类型 v1 两种：**排盘**、**AI 解读**。
- 每个步骤可配置「**自动过 / 暂停待确认**」。
- 运行时**混合驱动**：自动步连跑，暂停步停下来让卦师润色 / 重跑 / 继续。
- 暂停时卦师对产出的编辑，会作为后续步骤的上下文向下传。
- 运行可选关联客户档案，用其生辰预填排盘。
- 复用现有排盘 runner、发话链路、skill 快照、模型策略，后端新增量尽可能小。

## 非目标

- 不做条件分支 / 并行 / 循环（**纯线性**）。
- 不做可视化 DAG 拖拽编排。
- 不做内置"整理成稿"步骤——卦师用 **AI 步**自行实现（一个 prompt 写成"把以上产出整理为复盘素材"即可）。
- 不做跨用户共享 / 工作流市场（v1）。
- 不引入独立的运行状态机表——**会话即运行记录**。
- 不改现有专业排盘入口、不改简易模式 admin preset。

## 推荐方案

核心判断：**不造新引擎，而是"循环调用"那个还活着的单步引擎**。

> 多步线性流程 = 在同一个会话里，按卦师排好的步骤，把现有单步调用循环 N 次，每次把前面步骤的产出拼进 prompt。

可直接继承的现成积木：

| 能力 | 现成的东西 | 位置 |
|---|---|---|
| 排盘步 | `executeDirectPaipan({ skillDir, input })` → 盘面 | `paipan-runtime.ts` |
| AI 解读步 | `sendOwnedChatSessionMessage(..., { runtimeUserMessageOverride, authorizedWorkflowSkillIds, llmRuntimeOverride })` | `chat-session-service.ts:718` |
| 绑 skill 不漂移 | skill 快照机制 | `simple-workflow-repository.ts:255` |
| 模型策略解析 | `resolveSimpleWorkflowLlmRuntime(userId, modelPolicy)` | `system-config.ts` |
| 运行记录 | 现有 `chat_sessions` + `messages`（带 `metadata.stage`） | 已存在 |
| 客户生辰预填 | `applyClientProfilePrefill(userId, clientId, paipanInput)` | `client-profile-service.ts` |

### 运行驱动方式（混合的实现关键）

由**前端驱动循环**：

```text
前端跑第 K 步
  → 调后端"单步执行"接口
  → 等该步产出完成（AI 步的回复本就是异步生成，现有聊天界面已会等）
  → 读 step.pauseAfter：
      false（自动过）→ 直接续跑第 K+1 步
      true （暂停）  → 停住，给 [润色编辑] [重跑] [下一步]
```

这样**后端不需要复杂的同步串跑逻辑**：自动与暂停的差别只是"前端要不要停下来等点击"。后端只需两块新东西：

1. `workflow_definitions` 表（按 `user_id` 隔离）+ repo + CRUD 路由。
2. 一个"**单步执行**"服务：前端说"跑这个流程第 K 步"，后端**从存储的定义里**读该步配置、渲染模板、套用 skill 快照与模型策略，再转调 `executeDirectPaipan` / `sendOwnedChatSessionMessage`。

> 模板、绑定 skill、模型策略一律**服务端权威解析**，不信任前端传参——否则客户端可篡改 prompt / 越权用 skill。

## 步骤类型与数据结构（schema 待定稿）

两种步骤共享一个判别联合（discriminated union）。公共字段：

- `id`：步骤稳定 id（被引用语法和运行记录用，**不可随便变**）。
- `type`：`'paipan' | 'ai'`。
- `title`：卦师可读名称。
- `pauseAfter`：`boolean`——此步产出后是否暂停等卦师确认。

排盘步特有：术数 `skill`、排盘默认参数 `inputDefaults`。
AI 步特有：`promptTemplate`（可引用前序产出）、绑定 `skillIds`（保存时快照 → `skillSnapshotIds`）、`modelPolicy`。

> **以下为建议草案，最终类型定义留给项目作者定稿**（见文末"后续实现顺序"第 1 步）。开放点：是否给排盘步也加可选 prompt 备注；`modelPolicy` 是否每步独立还是工作流级共享；引用字段的命名（`output` / `board`）。

```ts
// 建议草案 —— 待定稿
type WorkflowStepModelPolicy = SimpleModelPolicy; // 复用现有：system-default | user-current | fixed + thinkingLevel

interface WorkflowStepBase {
  id: string;
  title: string;
  pauseAfter: boolean;
}

interface WorkflowPaipanStep extends WorkflowStepBase {
  type: 'paipan';
  skill: string;                       // 术数，如 'bazi-paipan'
  inputDefaults: Record<string, unknown>;
}

interface WorkflowAiStep extends WorkflowStepBase {
  type: 'ai';
  promptTemplate: string;              // 可含 {{ 引用 }}
  skillIds: string[];                  // 绑定的源 skill（保存时快照）
  skillSnapshotIds: string[];          // 快照 id（服务端写入）
  modelPolicy: WorkflowStepModelPolicy;
}

type WorkflowStep = WorkflowPaipanStep | WorkflowAiStep;
```

## 数据模型

新增 `workflow_definitions`（卦师作者作用域）：

```text
workflow_definitions {
  id           TEXT PRIMARY KEY
  user_id      TEXT NOT NULL          # 作者 = 卦师；所有查询按它隔离
  name         TEXT NOT NULL
  description  TEXT DEFAULT ''
  steps        JSONB NOT NULL         # 有序的 WorkflowStep[]
  enabled      BOOLEAN DEFAULT true
  sort_order   INTEGER DEFAULT 0
  created_at   TIMESTAMPTZ
  updated_at   TIMESTAMPTZ
  deleted_at   TIMESTAMPTZ            # 软删除
}
```

约束：

- `steps` 为有序数组；每个 step 必须有稳定 `id`。
- AI 步绑定的 skill 在**保存定义时**做快照（继承 `createWorkflowSkillSnapshots` 逻辑），快照 id 写回该 step。
- 编辑工作流改动 skill 绑定时，刷新对应快照（沿用 simple-workflow 的 upsert + 清理孤儿快照）。

**运行不另建表**：

- 一次运行 = 一个 `chat_session`。
- 每步产出 = 一条 `message`，用 `metadata` 标记：`workflow_definition_id`、`workflow_step_id`、`stage`。
- 排盘步的盘面继续走 `tool_context`（`SkillContextEntryDto`）。
- 因此"跑完后在会话里继续追问"天然可用。

## 上下文与变量

- 运行上下文 = `input.*`（启动表单字段）+ 各已完成步骤产出。
- AI 步 `promptTemplate` 用 `{{ ... }}` 引用，例如 `{{排盘.盘面}}`、`{{初断.产出}}`、`{{input.问题}}`。
- UI 提供「**插入引用**」按钮，卦师从已排步骤里点选，**不手写变量**。
- 渲染时机：执行某步前，后端从该会话里**已完成步骤的最新消息内容**取值拼入——所以卦师在暂停时润色过的版本，就是后续步骤拿到的输入。

## API 设计

CRUD（均按 `user_id` 隔离、鉴权）：

```text
GET    /api/workflows            列出我的工作流
POST   /api/workflows            新建
GET    /api/workflows/:id        读取单个
PATCH  /api/workflows/:id        更新（含 steps；改 skill 绑定时刷新快照）
DELETE /api/workflows/:id        软删除
```

运行：

```text
POST /api/workflows/:id/runs
  body: { clientId?: string, input: Record<string, unknown> }
  作用：校验定义可用 → 建会话（可关联客户）→ 返回 run（= session）+ 步骤清单与首步信息

POST /api/workflows/:id/runs/:sessionId/steps/:stepId/execute
  作用：服务端读定义该步配置 → 渲染上下文 → 转调 executeDirectPaipan / sendOwnedChatSessionMessage
  返回：该步产出 message（含 pauseAfter，供前端决定是否自动续跑）
```

设计取舍：

- 沿用 simple-workflow 的原子性教训——**单步内部要么完整产出、要么明确失败态**，不留半成品。
- 运行不做"一次性原子跑完整个流程"的大接口，因为多步 + 人在环更适合"逐步接口 + 前端编排"。

## 前端组件边界

- `/workflows` 一级入口：我的工作流列表（模板库）+ 新建。`/studio` 继续承载"临时手动排盘"，两者心智分开。
- `WorkflowBuilder`（搭建器）：增删步骤、拖动排序、每步配置、`pauseAfter` 开关、AI 步的"插入引用"。
- `WorkflowRunner`（运行器）：跑 + 暂停接管（`[润色编辑] [重跑] [下一步]`），复用现有会话消息渲染。
- 运行入口二选一/都做：`/workflows` 内点"运行"，或从**客户详情页**"用工作流断这个客户"（自动带 `clientId`）。

界面原则：

- 搭建器面向卦师（懂术数），可以暴露术数、skill、模型；运行器面向"跑"，突出每步产出与接管动作。
- 暂停步的产出可编辑（`textarea`），编辑即覆盖该步消息内容。

## 数据流（示例：八字事业分析）

工作流：① 排盘（自动过）② AI 初断（自动过）③ AI 深化（暂停）④ AI 整理（暂停，卦师自建的"整理成稿" AI 步）。

```text
卦师在 /workflows 点"运行"，选客户、填问题方向
→ POST /api/workflows/:id/runs  建会话（带 clientId）
→ 前端跑 ①：execute step① → executeDirectPaipan(八字, 客户生辰预填) → 盘面消息
   step①.pauseAfter=false → 自动续
→ 前端跑 ②：execute step② → 渲染 {{排盘.盘面}}+{{input.问题方向}} → sendOwnedChatSessionMessage（绑格局解读法快照） → 初断消息
   step②.pauseAfter=false → 自动续
→ 前端跑 ③：execute step③ → 渲染 {{初断.产出}} 等 → AI 深化消息
   step③.pauseAfter=true → 停。卦师润色③产出
→ 卦师点"下一步"
→ 前端跑 ④：execute step④ → 渲染 {{深化.产出(润色后)}} 等 → 整理稿
   step④.pauseAfter=true → 停。卦师整体润色，作为复盘素材
```

## 异常与兜底

- 找不到定义 / 已禁用 / 非本人：返回可读错误，不建会话。
- 排盘步失败：若是首步则不建会话；非首步则标记该步失败、可重跑，不污染后续。
- AI 步失败：保留会话与已产出步骤，该步显示可重跑状态。
- 暂停步：卦师可"重跑"覆盖该步产出。
- 客户档案缺生辰：排盘步按需提示补填。
- 绑定 skill 快照不可用：警告并降级为基础上下文（沿用现有行为）。

## 权限与计费

- 每个 AI 步 = 一次正常计费发话，完全复用现有发话链路的余额 / 权限校验。
- 工作流不绕过任何 entitlement；排盘步与 AI 步都走既有鉴权。

## 验证计划

后端单测：

- 定义 CRUD 的用户隔离（A 用户读不到 B 的工作流）。
- 单步执行：排盘步调对 runner；AI 步带对快照与模型策略。
- 模板渲染取"已完成步骤最新消息内容"（验证润色后版本被引用）。
- 各失败态返回可读错误、不留半成品。

前端测试：

- 搭建器增删 / 排序 / `pauseAfter` 开关。
- 运行器：自动步连跑、暂停步停下并出现接管动作。
- 编辑暂停步产出后，后续步引用到编辑版。

手工走查：

- 建一个 2–3 步工作流并跑通。
- 暂停润色后，确认后续步引用的是润色版。
- 关联客户运行，排盘步用其生辰预填。
- 跑完后在会话里继续追问正常。

建议命令：

```bash
pnpm --filter fateclaw-api test
pnpm --filter fateclaw-web exec tsc --noEmit
pnpm --filter fateclaw-web test
```

## 后续实现顺序

1. **contracts** 定 `WorkflowStep` / `WorkflowDefinition` DTO（**步骤 schema 由项目作者定稿**；注意 contracts barrel 需显式具名 re-export，避免 turbopack 星号透传坑）。
2. 迁移 + repo（`workflow_definitions`，用户隔离 + skill 快照）+ CRUD 路由 + 单测。
3. `workflow-run-service`：启动运行 + 单步执行（复用积木）+ 单测。
4. `/workflows` 列表 + `WorkflowBuilder` 搭建器。
5. `WorkflowRunner` 运行器（混合驱动 + 暂停接管）。
6. 客户详情页接入 + 端到端走查。
