# FateClaw 简易模式 Workflow 设计

日期：2026-06-09

## 背景

当前 `/ai-chat` 首页已经有“简易模式”和“专家模式”的入口雏形。专家模式承载完整对话、手动排盘、自贴盘面、Skill 和模型控制；简易模式的目标是给新手和普通用户一个更短路径，让用户不用理解术数参数、Skill 或 workflow，也能完成一次可保存的 AI 解读。

本设计确定简易模式的首版边界：

- 占卜问事固定使用六爻。
- 命理分析固定使用八字。
- 用户端只选择“占卜问事”或“命理分析”，不选择术数、Skill、workflow 或模型。
- 后台通过 workflow preset 配置对应的排盘默认值、模型策略、Skill Bundle 和提示词。

## 目标

简易模式要完成以下事情：

- 在 `/ai-chat` 的简易模式中提供两栏入口：`占卜问事` 和 `命理分析`。
- 占卜问事只收集问题和可选背景，系统自动用六爻起卦。
- 命理分析收集八字排盘所需的出生日期、出生时间、性别和问题方向。
- 后端根据入口类型读取后台启用的默认 workflow preset。
- 后端自动排盘，将盘面作为会话 tool context 保存。
- 后端按 preset 解析模型策略和 Skill Bundle，创建会话并触发第一轮 AI 解读。
- 用户完成简易模式后进入普通 AI Chat 会话，后续追问沿用现有聊天体验。

## 非目标

本次不做以下内容：

- 不做意图识别；用户明确选择占卜或命理。
- 不在简易模式里暴露术数选择。
- 不在简易模式里暴露模型选择、思考等级、Skill 选择或 workflow 选择。
- 不做可视化 workflow 编排器。
- 不让用户自定义简易 workflow。
- 不在首版命理分析里支持紫微、时区选择或出生地校正。
- 不改变专家模式现有手动排盘能力。

## 推荐方案

采用“前台两栏固定入口 + 后台 workflow preset 配置”的方案。

前台保持极简：

```text
简易模式
├─ 占卜问事：六爻
└─ 命理分析：八字
```

后台保持可运营：

```text
simple-divination-default
├─ kind: divination
├─ paipanSkill: iching-paipan
├─ paipanInputDefaults: { method: 'dayan' }
├─ modelPolicy: { mode: 'user-current', thinkingLevel: 'medium' }
├─ skillBundleIds: []
└─ promptTemplate: "结合用户问题、背景补充和六爻盘面，用新手能理解的方式给出判断。"

simple-natal-default
├─ kind: natal
├─ paipanSkill: bazi-paipan
├─ paipanInputDefaults: { include: ['bazi', 'fortune', 'pattern'] }
├─ modelPolicy: { mode: 'system-default', thinkingLevel: 'medium' }
├─ skillBundleIds: []
└─ promptTemplate: "结合用户问题方向和八字盘面，给出结构化命理分析。"
```

这个方案比硬编码更方便运营，也比开放式 workflow 编辑器更适合首版。用户端不会增加认知负担，后台仍然可以调整模型、Skill 和提示词。

## 用户旅程

### 进入简易模式

用户在 `/ai-chat` 首页点击“简易模式”，进入简易模式二级入口。

页面展示两张入口卡片：

- `占卜问事`：适合近期选择、关系走向、工作决策、单件事情。
- `命理分析`：适合长期性格、事业方向、关系模式、人生阶段。

### 占卜问事

用户填写：

- `问题`：必填。
- `背景补充`：可选。

提交后系统执行：

1. 使用后台 `divination` 默认 preset。
2. 调用六爻排盘，默认输入为 `{ method: 'dayan' }`。
3. 将用户问题、背景补充和六爻盘面拼入 preset 的提示词模板。
4. 按 preset 的模型策略选择模型和思考等级。
5. 加载 preset 绑定的 Skill Bundle。
6. 创建会话，保存盘面 tool context，并生成第一轮解读。

### 命理分析

用户填写：

- `出生日期`：公历，必填。
- `出生时间`：公历时间，必填。
- `性别`：必填。
- `问题方向`：必填，例如事业、感情、财运、整体。

提交后系统执行：

1. 使用后台 `natal` 默认 preset。
2. 调用八字排盘，输入包含 `solarDate`、`hour`、`minute`、`gender`。
3. 默认包含八字、大运流年和格局信息。
4. 将问题方向和八字盘面拼入 preset 的提示词模板。
5. 按 preset 的模型策略选择模型和思考等级。
6. 加载 preset 绑定的 Skill Bundle。
7. 创建会话，保存盘面 tool context，并生成第一轮解读。

## 模型策略

简易模式不让用户选择模型。模型由 workflow preset 决定。

建议支持三种模型策略：

```ts
type SimpleModelPolicyMode = 'system-default' | 'user-current' | 'fixed';

interface SimpleModelPolicy {
  mode: SimpleModelPolicyMode;
  fixedModelId?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
}
```

策略含义：

- `system-default`：使用系统默认官方模型，适合简易模式的稳定兜底。
- `user-current`：沿用用户当前模型设置，适合让付费用户保留自己的模型偏好。
- `fixed`：后台指定某个模型，适合需要强控输出质量的 workflow。

建议首版默认：

- 占卜问事使用 `user-current`，不可用时回退到 `system-default`。
- 命理分析使用 `system-default`，思考等级至少为 `medium`。

最终使用的模型策略需要写入会话元数据，便于后台日志排查和后续账单分析。

## Workflow Preset 数据模型

建议新增后台配置实体 `simple_workflow_presets`。

核心字段：

```ts
type SimpleWorkflowKind = 'divination' | 'natal';

interface SimpleWorkflowPreset {
  id: string;
  kind: SimpleWorkflowKind;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  entryTitle: string;
  entryDescription: string;
  paipanSkill: 'iching-paipan' | 'bazi-paipan';
  paipanInputDefaults: Record<string, unknown>;
  modelPolicy: SimpleModelPolicy;
  skillBundleIds: string[];
  promptTemplate: string;
  sortOrder: number;
}
```

约束：

- 每个 `kind` 同一时间只能有一个启用的默认 preset。
- `divination` preset 的 `paipanSkill` 必须是 `iching-paipan`。
- `natal` preset 的 `paipanSkill` 必须是 `bazi-paipan`。
- `promptTemplate` 必须能引用用户输入和盘面摘要。
- `skillBundleIds` 可以为空，但后台应给出提醒，因为没有 Skill 时 workflow 质量可能不稳定。

## API 设计

建议新增简易模式启动接口：

```text
POST /api/simple-workflows/start
```

请求体：

```ts
type SimpleWorkflowStartRequest =
  | {
      kind: 'divination';
      question: string;
      background?: string;
    }
  | {
      kind: 'natal';
      solarDate: string;
      hour: number;
      minute?: number;
      gender: '男' | '女';
      questionDirection: string;
    };
```

响应体：

```ts
interface SimpleWorkflowStartResponse {
  session: {
    id: string;
    title: string;
  };
  boardMessageId: string;
  assistantMessageId?: string;
}
```

接口职责：

- 校验用户登录和余额状态。
- 根据 `kind` 读取默认 preset。
- 校验用户输入。
- 调用对应排盘 runner。
- 创建或写入会话。
- 保存盘面 tool context。
- 按 preset 创建首条用户问题并触发 AI 回复。

不建议让前端分别调用“排盘接口”和“发送消息接口”。简易模式需要一个原子启动接口，避免出现排盘已成功但会话创建失败、或会话已创建但首问未发送的半成品状态。

## 前端组件边界

建议新增或调整以下组件：

- `SimpleModeHome`：展示占卜问事和命理分析两栏入口。
- `SimpleDivinationForm`：占卜问事表单。
- `SimpleNatalForm`：命理分析表单。
- `useSimpleWorkflowStart`：封装提交、loading、错误提示和成功跳转。

接入位置：

- `AiChatWorkspace` 保留现有 `HomeModeSelector`。
- 用户点击简易模式后进入 `SimpleModeHome`。
- 用户完成简易模式启动后，设置当前 selected session，进入现有 AI Chat 会话视图。

界面原则：

- 两栏入口只解释适用场景，不解释术数理论。
- 表单只展示必要字段。
- 模型、Skill、workflow 不在用户端出现。
- 错误提示使用普通语言，不暴露内部 preset、runner 或 tool context 术语。

## 数据流

### 占卜问事

```text
用户提交问题
→ POST /api/simple-workflows/start { kind: 'divination' }
→ 读取 divination 默认 preset
→ runIchingPaipan({ method: 'dayan' })
→ 格式化六爻盘面 tool context
→ 解析模型策略和 Skill Bundle
→ 创建会话和盘面消息
→ 发送首轮 AI 解读
→ 前端跳转到新会话
```

### 命理分析

```text
用户提交出生信息和问题方向
→ POST /api/simple-workflows/start { kind: 'natal' }
→ 读取 natal 默认 preset
→ runBaziPaipan({ solarDate, hour, minute, gender, include: ['bazi', 'fortune', 'pattern'] })
→ 格式化八字盘面 tool context
→ 解析模型策略和 Skill Bundle
→ 创建会话和盘面消息
→ 发送首轮 AI 解读
→ 前端跳转到新会话
```

## 异常与兜底

### 配置异常

- 找不到对应 `kind` 的默认 preset：提示“当前简易模式暂不可用，请稍后再试”。
- preset 被禁用：同上，并记录后台错误日志。
- preset 指定的 Skill Bundle 不存在或不可用：继续使用基础排盘上下文，并记录 warning。
- preset 指定 fixed 模型不可用：回退到系统默认模型。

### 用户输入异常

- 占卜问题为空：提示“请先写下你想问的事情”。
- 命理出生日期缺失或非法：提示“请填写有效的公历出生日期”。
- 命理出生时间缺失：提示“请填写出生时间；如果不确定，可先选择最接近的整点”。
- 命理性别缺失：提示“请选择性别，用于八字起运计算”。

### 运行异常

- 排盘失败：不创建会话，提示“排盘失败，请检查信息后重试”。
- 会话创建失败：不发送 AI 回复，提示“创建会话失败，请稍后重试”。
- AI 回复失败：保留已创建会话和盘面消息，在会话内显示可重试状态。

## 验证计划

单元测试覆盖：

- `divination` 请求会读取六爻默认 preset。
- `natal` 请求会读取八字默认 preset。
- 占卜问事会调用 `iching-paipan`，并传入默认 `method: 'dayan'`。
- 命理分析会调用 `bazi-paipan`，并传入 `solarDate`、`hour`、`minute`、`gender`。
- 每个 `kind` 只能解析到一个默认启用 preset。
- fixed 模型不可用时会回退到系统默认模型。
- 缺少必要字段时返回可读错误。
- 排盘成功后会生成 tool context 并保存到会话消息。

前端测试覆盖：

- 简易模式二级入口展示占卜和命理两栏。
- 占卜问事表单只要求问题。
- 命理分析表单要求出生日期、出生时间、性别和问题方向。
- 提交成功后切换到新会话。
- 提交失败时保留表单输入并展示错误。

手工走查覆盖：

- 未登录用户点击简易模式时走现有登录逻辑。
- 登录用户完成占卜问事并进入会话。
- 登录用户完成命理分析并进入会话。
- 占卜问事生成的会话包含六爻盘面。
- 命理分析生成的会话包含八字盘面。
- 简易模式后续追问使用现有 AI Chat 输入框。
- 专家模式入口和现有手动排盘不受影响。

建议验证命令：

```bash
pnpm --filter fateclaw-web exec tsc --noEmit
pnpm --filter fateclaw-api test
pnpm --filter fateclaw-web test
```

## 后续实现顺序

1. 增加 `simple_workflow_presets` 配置模型、迁移和仓储。
2. 增加后台管理接口，用于查看和编辑简易 workflow preset。
3. 增加 `POST /api/simple-workflows/start`。
4. 复用现有六爻和八字排盘 runner，封装简易模式排盘输入。
5. 复用现有会话、tool context 和 AI Chat 发送链路。
6. 在 `/ai-chat` 接入 `SimpleModeHome`、占卜表单和命理表单。
7. 增加前后端测试和关键路径手工走查。
