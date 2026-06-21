# FateClaw 卦师工作流 DAG 版设计(取代线性版)

日期:2026-06-21
状态:设计稿(待实现)。**取代** `2026-06-21-guashi-custom-workflow-design.md`(线性版)。

## 0. 背景与方向修正

先做了"线性多步"版(分支 feat/guashi-custom-workflow 共 6 commit,后端+前端全绿、已提交)。用户看成品后明确:要的是 **Dify/Coze 式画布**,且分支语义是**并行分叉 + 汇总(fan-out / fan-in)**,**不是条件判断**。

关键澄清(用户原话归纳):
1. 用正常排盘流程排盘;
2. 盘面发送给不同分支,每条分支可设不同 skill;
3. 分支可汇总到一个新节点,同样有 skill 设定;
4. 可以有多个输出,来自不同分支。

**重要推论:没有 if/条件节点。** 每条边都执行,不存在"判走哪条"的难题。引擎 = 节点在其上游全部完成后按拓扑序执行。这比条件 DAG 简单得多。

线性版的"底层积木"全部留用,只是从"线性 steps[]"重塑成"图 nodes[]+edges[]";运行器与搭建器重写。

## 1. 目标

- 画布式搭建:拖拽节点、连线(`@xyflow/react` / React Flow,React 19 兼容)。
- 节点类型 v1:**排盘节点**(走正经排盘流程、完整参数)、**AI 解读节点**(绑 skill + prompt 模板 + 模型策略)。
- **分叉**:一个节点的产出可连到多个下游节点。
- **汇总(join)**:一个 AI 节点可有多条入边,prompt 里引用各上游产出。
- **多输出**:多个末端(叶)节点,各自是一份成品。
- 每节点可设 `pauseAfter`(暂停让卦师润色/确认),沿用混合运行。
- 复用排盘引擎、AI+skill 快照、模板渲染、消息 id 约定、保存润色、`workflow_definitions` 表。

## 2. 非目标(v1)

- **不做条件分支 / if 路由**(用户要的是并行,不是条件)。
- **不做真并发执行**:同一 chat session 有"处理中"锁,并发 AI turn 会冲突。**并行分支按拓扑序逐个跑**(结构并行、执行串行)。后续若需要再做多 session 并发。
- 不做循环。
- 不做跨用户共享 / 市场。
- 不引入条件变量抽取节点。

## 3. 数据模型

沿用 `workflow_definitions` 表。**迁移 0063:把 `steps JSONB` 列改为承载图**——推荐新增迁移 `ALTER TABLE workflow_definitions RENAME COLUMN steps TO graph`(或加 `graph JSONB`,弃用 steps)。JSONB 形状灵活,存:

```ts
interface WorkflowGraphDto {
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
}

interface WorkflowNodeBaseDto {
  id: string;            // 稳定 id,仅 [A-Za-z0-9_](消息 id 约定 wf-<id>-..._reply 用 '-' 分隔)
  title: string;
  pauseAfter: boolean;
  position: { x: number; y: number };  // 画布坐标
}

interface WorkflowPaipanNodeDto extends WorkflowNodeBaseDto {
  type: 'paipan';
  skill: string;                       // 术数 skillDir,如 'bazi-paipan'
  inputDefaults: Record<string, unknown>;  // 排盘参数(走真排盘参数表单填)
}

interface WorkflowAiNodeDto extends WorkflowNodeBaseDto {
  type: 'ai';
  promptTemplate: string;              // 可引用 {{input.x}} / {{node.<上游id>.output}}
  skillIds: string[];
  skillSnapshotIds: string[];          // 服务端保存时写入(快照)
  modelPolicy: SimpleModelPolicyDto;   // 每节点独立
}

type WorkflowNodeDto = WorkflowPaipanNodeDto | WorkflowAiNodeDto;

interface WorkflowEdgeDto {
  id: string;
  source: string;  // 上游节点 id
  target: string;  // 下游节点 id
}
```

`WorkflowDefinitionDto` 的 `steps: WorkflowStepDto[]` → `graph: WorkflowGraphDto`。

约束:图必须无环(DAG);每节点 id 唯一且稳定;排盘节点一般是源(无入边)。

## 4. 执行模型(拓扑 + 串行)

- 运行 = 一个 chat session(沿用线性版:run 不另建状态表,节点产出 = message)。
- 节点"就绪" = 其所有入边的上游节点都已完成。
- 前端驱动:计算拓扑序;按序逐个执行就绪节点(串行)。
- **排盘节点**:`executeDirectPaipan({ skillDir, input: merge(inputDefaults, 客户生辰预填) })` → 落带 tool_context 的盘面消息(metadata.workflow_node_id)。同步,不用等。
- **AI 节点**:
  - 上下文 = 各入边上游节点产出(`{{node.<id>.output}}`)+ 本次输入(`{{input.x}}`)+ 盘面(靠会话 `selectedBoardMessageId` 自动透传,**不进引用语法**)。
  - 渲染 prompt(复用 `renderWorkflowPrompt`,把 `step.` 语法改/兼容为 `node.`)。
  - `sendOwnedChatSessionMessage(...,{ runtimeUserMessageOverride: 渲染后prompt, llmRuntimeOverride: 按modelPolicy, authorizedWorkflowSkillIds: 该节点快照 })`。
  - 用户消息 id = `wf-<nodeId>-<ts>-<rand>`,回复 = `..._reply`(沿用约定;`collectStepOutputs` 按 id 切出 nodeId,取最新→拿到润色版)。
  - 前端轮询 `GET /api/chat-sessions/s/:sid/messages` 等该 `assistantMessageId` 的 `metadata.kind==='final'`(沿用线性运行器逻辑)。
- `pauseAfter`:该节点完成后暂停,卦师可润色/重跑/继续;继续则跑下一个就绪节点。
- **多输出**:叶节点(无出边)各自展示为一份成品。

## 5. 排盘节点的"完整参数"

复用真排盘的参数能力,两条路(实现期二选一):
- **(推荐)schema 驱动**:用排盘目录的参数 schema(契约里有 `PaipanCatalogItemDto` / `SkillParametersSchemaDto`,`paipanApi` 提供 catalog),在节点里按 schema 渲染字段 → 存进 `inputDefaults`。耦合低。
- **复用 paipan-flows**:把 `components/ai-chat/paipan-flows/` 的引导表单提到节点里。体验最一致,但那些组件目前与排盘 sheet 耦合,需解耦。

运行时合并:`inputDefaults` + `applyClientProfilePrefill(clientId)`(命理类必须从客户入口带生辰)。

## 6. 快照(保存时拍)

沿用线性版 `applyDefinitionSkillSnapshots`(`workflow-definition-repository.ts`):遍历对象从"steps 里的 ai 步"改成"nodes 里的 ai 节点",为每个 ai 节点的 skillIds 生成快照、回填 skillSnapshotIds。audit source 仍复用 `'simple_workflow_snapshot'`(被 skills 列表既有过滤自动隐藏),按 `workflow_definition_id` 区分。

## 7. 后端 API(多数复用,run 改成按节点)

- CRUD:`GET/POST/GET:id/PUT:id/DELETE:id /api/workflows`(复用;body 的 steps→graph)。
- 运行:
  - `POST /api/workflows/:id/runs`(建会话 + 写运行起始消息存 input/clientId;返回 session + 节点清单/图)。
  - `POST /api/workflows/:id/runs/:sessionId/nodes/:nodeId/execute`(原 steps/:stepId/execute 改 nodes/:nodeId;服务端读节点配置、按入边收集上游产出渲染、转调排盘/AI)。
  - `PATCH /api/workflows/:id/runs/:sessionId/nodes/:nodeId/output`(保存润色;复用 saveWorkflowStepOutput→按 nodeId)。
- 服务端"上游产出收集":execute 某 AI 节点时,从图找该节点的入边 → 各上游 nodeId → 从会话消息按 id 约定取各自最新 `_reply` 内容 → 作为渲染上下文。

## 8. 契约变更(packages/contracts/src/workflow)

- 删/改:`WorkflowStepDto` 系列 → `WorkflowNodeDto`(paipan/ai 判别联合)+ `WorkflowEdgeDto` + `WorkflowGraphDto`。
- `WorkflowDefinitionDto.graph`、`WorkflowDefinitionUpsertDto.graph`(node 输入态 ai 节点不带 skillSnapshotIds)。
- 运行 DTO:`WorkflowRunStartResponseDto` 返回 `nodes`/`graph`;`WorkflowRunNodeExecuteResponseDto`(原 step→node)。
- 前端走 `import type` + `export type` 别名(无 export*,避开 turbopack 坑)。

## 9. 前端

- 依赖:新增 `@xyflow/react`。
- 搭建器 `app/workflows/new|edit`:React Flow 画布。
  - 自定义节点组件:排盘节点、AI 节点(显示标题/类型/skill 数/pause 标记)。
  - 侧栏/弹层配置面板:选中节点编辑其配置(排盘参数 / AI prompt+引用+skill+模型+pause)。
  - 连线生成 edges;校验无环。
  - "插入引用":AI 节点 prompt 里插 `{{node.<上游id>.output}}`(只列该节点的上游)+`{{input.question}}`。
- 运行器 `app/workflows/run`:渲染图 + 拓扑执行(沿用线性运行器的 execute+轮询+暂停接管,改成按图取下一个就绪节点);多输出区展示各叶节点成品;跑完进会话。
- 旧线性 `workflow-builder.tsx`(卡片)+ 线性 run 逻辑**重写/取代**。

## 10. 复用 vs 重写 映射

| 模块 | 处置 |
|---|---|
| 排盘引擎 `executeDirectPaipan` | 复用 |
| AI 发话 + skill 快照授权 | 复用 |
| `applyDefinitionSkillSnapshots` | 复用(遍历 nodes) |
| `renderWorkflowPrompt` / `collectStepOutputs` | 复用(step→node 命名;收集改"按入边") |
| `saveWorkflowStepOutput` + 消息编辑端点 | 复用(stepId→nodeId) |
| `workflow_definitions` 表 | 复用(迁移 0063 steps→graph) |
| CRUD 路由/服务骨架 | 复用(steps→graph) |
| 运行服务"线性循环" | **重写**为拓扑执行 + 上游收集 |
| 搭建器卡片 UI | **重写**为画布 |
| 运行器 UI | **改写**为按图执行 |
| 契约 WorkflowStepDto 系列 | **改**为 Node/Edge/Graph |

## 11. 实施顺序(阶段,每阶段可验证)

1. **契约**:Node/Edge/Graph DTO(替换 Step 系列)。
2. **迁移 0063** steps→graph + 仓储/服务/CRUD 适配(steps→graph);`migrations.test` 台账补 0063。
3. **快照** 适配遍历 nodes;**run-service** 重写:start + execute(按入边收集上游)+ saveOutput(nodeId)+ 拓扑/就绪判定的服务端校验。后端单测(渲染/上游收集/快照/CRUD)。
4. **前端依赖** 加 `@xyflow/react`;搭建器画布(节点组件 + 配置面板 + 连线 + 无环校验 + 排盘完整参数)。
5. **运行器** 按图拓扑执行 + 暂停接管 + 多输出。
6. **客户入口** 沿用(`/workflows?client=`)。
7. typecheck(api+web)+ 单测 + 真机冒烟。

## 12. 开放点 / 待定

- 迁移用 rename 还是新增 graph 列(推荐 rename,因功能未上线)。
- 排盘节点参数 UI:schema 驱动(推荐)vs 提取 paipan-flows。
- 是否保留旧线性代码做过渡(倾向直接替换,git 历史已留线性版)。
- 多输出在运行器的呈现(并排卡片 / 标签页)。
- 无环校验放前端(连线时)+ 后端(保存时)双保险。
