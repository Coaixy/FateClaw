# 手动排盘引导式填写设计

## 背景

当前 AI Chat 的手动排盘弹窗由 `apps/web/components/ai-chat/paipan-sheet.tsx` 承担。这个文件同时处理弹窗壳、术数选择、常用字段、Schema 高级字段、预览、提交和预览渲染，文件规模已经超过 2000 行。

现有“常用参数”已经按术数分支：

- 八字 / 紫微：出生日期、出生时间、性别。
- 奇门：当前时间或指定起盘时间。
- 六爻 / 经占：起卦方式、起卦时间、数字或手动卦象、问题。

目标是保留现有术数选择方式，把选中术数后的常用参数填写改为面向新手的一步一步引导，并把不同术数的填写内容拆到独立文件中。

## 目标

- 保留现有手动排盘入口和术数选择方式。
- 每个术数的常用参数由独立 flow 文件维护。
- `PaipanSheet` 继续负责弹窗生命周期、draft 状态、预览、提交、当前会话 / 新会话模式。
- 常用参数改为 stepper 引导式填写。
- 高级参数继续使用现有 `SchemaFields` 折叠区，不进入第一版引导步骤。
- 内部术数 ID 只用于匹配 flow 和提交 API，不在 UI 上展示。

## 非目标

- 不改后端排盘 API 协议。
- 不改 `paipanApi.preview` 和 `paipanApi.commit` 的请求形状。
- 不重写图表渲染组件。
- 不把自贴盘面合并进手动排盘弹窗。
- 不为第一版实现复杂分支动画或跨步骤保存草稿。

## 术数标识

前端应避免在 UI 代码中继续使用容易误解的 `skillDir` 命名。推荐在 flow 层使用明确的内部类型：

```ts
export type PaipanSkillId =
  | 'bazi-paipan'
  | 'ziwei-paipan'
  | 'iching-paipan'
  | 'jingzhan-paipan'
  | 'qimen-paipan';
```

`PaipanCatalogItem.skill` 仍然是后端提供的内部 key。UI 显示只使用 `PaipanCatalogItem.name`，绝不展示 `PaipanSkillId` / `skillDir`。

## 文件结构

新增目录：

```text
apps/web/components/ai-chat/paipan-flows/
  index.ts
  types.ts
  shared/
    paipan-step-frame.tsx
    paipan-stepper.tsx
  flows/
    bazi-flow.tsx
    ziwei-flow.tsx
    qimen-flow.tsx
    iching-flow.tsx
    jingzhan-flow.tsx
```

`paipan-sheet.tsx` 中已有的基础字段组件可以先保留原文件内，第一阶段只把 `SimplePaipanFields` 的术数分支迁出。后续如果文件仍然偏大，再把 `DateField`、`TimeField`、`ChoiceGrid`、`FieldTextInput`、`FieldTextarea` 迁到 `paipan-flows/shared/fields/`。

## Flow 接口

每个 flow 接收统一上下文，不直接负责提交：

```ts
interface PaipanFlowProps {
  draft: Record<string, unknown>;
  onChange: (path: string[], value: unknown) => void;
  onManyChanges: (changes: Array<{ path: string[]; value: unknown }>) => void;
}
```

flow 组件只负责渲染步骤和更新 draft。校验和最终 submit input 仍由 `PaipanSheet` 通过现有 `validateDraftForSkill`、`buildSubmitInputForSkill` 完成，避免校验逻辑分散。

注册表：

```ts
const PAIPAN_FLOW_REGISTRY: Record<PaipanSkillId, ComponentType<PaipanFlowProps>> = {
  'bazi-paipan': BaziFlow,
  'ziwei-paipan': ZiweiFlow,
  'iching-paipan': IchingFlow,
  'jingzhan-paipan': JingzhanFlow,
  'qimen-paipan': QimenFlow,
};
```

`PaipanSheet` 负责根据 `selectedCatalogItem.skill` 找到对应 flow。找不到 flow 时回退到原 `SchemaFields` 常规展示，避免新增术数导致弹窗空白。

## 步骤设计

### 八字

1. 出生日期。
2. 出生时间。
3. 性别。
4. 想问方向 / 备注。

### 紫微

1. 出生日期。
2. 出生时间。
3. 性别。
4. 想问方向 / 备注。

第一版紫微可以复用八字 flow 的主体，但独立文件保留，方便后续加入农历、闰月、命盘偏好等紫微专属说明。

### 奇门

1. 起盘时间选择：当前时间 / 指定时间。
2. 如果选择指定时间，填写起盘日期和时间。
3. 想问方向 / 备注。

### 六爻

1. 起卦方式。
2. 起卦时间：当前时间 / 指定时间。
3. 根据起卦方式填写额外参数：
   - `three`：三个数字。
   - `array`：数字列表。
   - `manual`：六爻卦象。
   - 其他方式不显示额外输入。
4. 想问什么。

### 经占

第一版与六爻 flow 共享大部分步骤，但保留独立 `jingzhan-flow.tsx`，用于后续调整经占专属文案和默认起卦方式。

## UI 行为

- 弹窗标题仍为“手动排盘”。
- 已选术数显示用户可读名称，例如“八字排盘”，不显示内部 ID。
- stepper 显示“第 1 步 / 共 N 步”和当前步骤标题。
- 上一步 / 下一步按钮只在常用参数区域内部控制步骤。
- 弹窗底部原有按钮保持：
  - `pre-chat`：生成盘面预览 / 基于此盘开始对话。
  - `current-session`：生成盘面预览 / 插入到当前对话。
- 高级设置仍在常用参数步骤之后，以折叠区形式展示。
- 生成预览后，如果用户修改任意字段，继续沿用现有 `resetPreviewState` 行为清空旧预览。

## 数据流

```text
用户选择术数
  -> PaipanSheet 设置 selectedCatalogItem
  -> 根据 selectedCatalogItem.skill 选择 flow
  -> flow 分步骤写入 draft
  -> PaipanSheet 继续使用 buildSubmitInputForSkill
  -> paipanApi.preview / paipanApi.commit
```

flow 不直接调用 API，不保存 session，不了解 `pre-chat` / `current-session`。这些仍是 `PaipanSheet` 的职责。

## 渐进迁移

1. 建立 `paipan-flows` 目录和类型。
2. 抽出 `PaipanStepper` / `PaipanStepFrame`。
3. 把 `SimplePaipanFields` 中的八字 / 紫微分支迁出。
4. 迁出奇门分支。
5. 迁出六爻 / 经占分支。
6. `SimplePaipanFields` 替换为 flow registry 渲染。
7. 保留 `SchemaFields` 高级设置不动。
8. 跑 web typecheck 和 build。

## 测试与验证

- `pnpm --filter fateclaw-web exec tsc --noEmit`
- `pnpm --filter fateclaw-web build`
- 手动验证：
  - 八字可逐步填写并生成预览。
  - 紫微可逐步填写并生成预览。
  - 奇门当前时间和指定时间两条路径都可生成预览。
  - 六爻 `dayan`、`manual`、`three`、`array` 路径都能正确显示对应步骤。
  - 经占路径可生成预览。
  - 修改字段会清空旧预览。
  - `pre-chat` 能从预览创建新会话。
  - `current-session` 能插入当前会话。
  - UI 不显示 `bazi-paipan`、`skillDir` 等内部 ID。

## 风险

- `paipan-sheet.tsx` 中基础字段组件还很多，第一阶段只迁 flow 分支会减少复杂度但不会立刻把文件变小到理想状态。
- 六爻 / 经占条件步骤较多，步骤切换时要避免隐藏字段留下过期值。第一版沿用现有 submit 清洗和校验逻辑，不在 flow 内另做清洗。
- 高级字段继续保留在折叠区，用户如果只看引导步骤，可能不知道有高级设置。需要在折叠标题下保留简短说明。

## 结论

第一版采用共享弹窗壳加独立术数 flow 的方案。`PaipanSheet` 保留业务流程，`paipan-flows` 管理新手引导式常用参数填写。内部术数 ID 只作为匹配和提交 key，不出现在 UI 文案中。
