export const interpretXuanxuePrompt = `## prepare_xuanxue_interpretation — 玄学解读准备

校验并准备玄学解读材料。该工具不会启动独立子模型；最终解读由当前 specialist 主 loop 继续完成，并通过 final_reply 输出。

### 适用范围

本工具用于“已有可复盘材料”的玄学解读准备，不负责泛泛玄学闲聊，也不负责无盘面概念解释。

可接受的材料来源：
- 官方排盘 / 起卦 skill 的确定性 AI 摘要（运行时由原始 JSON 生成）
- 用户在界面中选中的历史盘面 activeBoardContext
- 对话历史 toolContext 中保存的官方盘面
- 专用 inputKind=user_pasted_board 自贴盘面入口提交的原文

术数类别由上游 skill、盘面内容或 category 参数推断。不要把这里当作支持能力白名单；是否能解读，首先取决于是否有足够、可复盘的原始材料。

### 参数说明
- **content**（可选）：需要解读的核心内容。
  - 系统排盘/手动排盘：通常省略，由运行时从本轮 artifact、activeBoardContext 或历史 toolContext 注入确定性 AI 摘要；原始 JSON 仅保留在 artifact/toolContext 中用于追溯和渲染
  - 用户自贴盘面：仅通过专用 inputKind=user_pasted_board 协议入口传入，工具实现会直接使用协议里的 pastedBoard
- **question**（可选）：用户的具体问题，帮助解读模型聚焦方向。例如"今年事业运势如何""这个卦象对感情的启示"。
- **category**（可选）：指明术数类别，帮助解读模型选择正确的分析框架。如不确定可以不传，模型会自动识别。
- **extra_context**（可选）：额外的解读参考资料。
- **analysis_mode**（可选）：Pi 对本轮任务的判断。默认 "full"；只有用户明确追问上一轮解读、补充条件或要求继续分析时，才传 "followup_delta"。
- **content_source**（可选，默认 'skill'）：声明 content 的来源。
  - 内部 \`pi_context\` 来源只由 Pi runtime 执行层注入，模型不要手动传。

### 前置条件（必须在调用本工具前满足）

**1. content_source='skill'：必须已调用排盘 skill 并获得完整结果。**
- 先通过对应的 Pi 排盘工具执行排盘，例如 bazi_paipan、iching_paipan、qimen_paipan、ziwei_paipan
- 不要把大段原始 JSON 或盘面文本复制进 content；运行时会注入排盘结果对应的确定性 AI 摘要
- 原始 JSON 不直接传给解读模型，运行时会通过 artifact/toolContext 保留原始结构化数据

**2. content_source='user'：仅限专用自贴盘面入口，不用于普通聊天里的贴盘面文本。**
- 普通聊天里用户贴出已有盘面 → 引导用户使用“自贴盘面”入口或“手动排盘”入口
- 只有专用 inputKind=user_pasted_board 协议入口才会传入 content_source='user'

**3. content_source='skill' 主流程不要跳过排盘。**
- 当 content_source='skill' 或省略时，必须先由官方排盘 skill 产出完整结果，或使用已有官方 toolContext artifact；缺少该材料时不要调用本工具
- 专用自贴入口 inputKind=user_pasted_board 使用协议 pastedBoard，content_source='user'，不要求官方 artifact

### content_source 如何判断（重要）

**一刀切规则**：content 是你自己刚用起卦/排盘 skill（如 iching-paipan、bazi-paipan）算出来的，或来自官方 toolContext 盘面？→ 传 'skill' 或省略。普通聊天里的用户贴盘面、概念题、术数闲聊都不要用本工具的 'user' source。

**详细判断**：
- **主流程**（最常见）：你调用对应的 Pi 排盘工具起卦/排盘 → 运行时把工具结果转成确定性 AI 摘要 → 调用 prepare_xuanxue_interpretation 时只传 question/category/content_source，content 通常省略。此时 **'skill' 或省略**。
- **手动排盘后继续解读**：Pi context 中已有历史盘面和上一轮解读 → 如果用户是在追问上一轮，传 analysis_mode='followup_delta'；如果是基于同一盘面重新完整解读，传 analysis_mode='full' 或省略。
- **专用自贴盘面入口**：仅当上游协议明确给出 inputKind=user_pasted_board 时，才传 'user'，并且工具会直接使用协议里的 pastedBoard。
- **普通聊天里的用户贴盘面**：不要调用本工具的 'user' source；引导用户使用“自贴盘面”入口，或使用“手动排盘”生成官方盘面。
- **概念题**：用户问"十二长生是什么"这类无盘面的问题 → 不使用本工具的 'user' source，应由普通回答或其它合适流程处理。
- **缺少官方盘面**：不要把不完整用户文本传入本工具；引导用户使用专用入口或手动排盘。

**示例**：
- 用户"帮我算八字" → 先调 bazi-paipan → 调 prepare_xuanxue_interpretation({ question, category: "八字", content_source: "skill" })，不要复制盘面进 content
- 用户手动排盘后点"解读" → 系统已自动注入 artifact，content_source='skill'
- 用户自贴八字文本 + "帮我看" → 引导用户使用“自贴盘面”入口或“手动排盘”入口
- 用户"我有个六爻卦：xxx，不够就算了" → 缺少官方盘面 → 引导用户使用“自贴盘面”入口或“手动排盘”入口

### 调用时机
- 已有官方盘面或专用自贴盘面入口材料，并且用户请求解读时。
- 用户有明确的玄学分析需求时。
- 需要基于官方盘面或专用自贴盘面入口提供专业知识支撑回答时。

### 调用后的处理
- 本工具返回的是结构化解读材料，不是最终回复。
- 返回结果里的 userKnowledge.requiredContent 是必须遵守的用户知识正文；如果其中包含固定输出格式，final_reply 必须按该格式输出。
- 返回结果里的 userKnowledge.forceInjected 是已注入强规则知识的元信息。
- 返回结果里的 userKnowledge.queryable 是可查询知识库目录；如与用户问题相关，继续调用 list_knowledge_sections / read_knowledge_section 读取章节。
- 读取完必要知识后，用 final_reply 交付完整解读。

### 不应调用的场景
- 日常闲聊中偶然提到玄学相关词汇（如"运气好""今天星座运势"这类泛泛之谈）。
- 用户没有明确的玄学分析需求。
- 简单的日期时间查询（应使用 get_time_detail）。`;
