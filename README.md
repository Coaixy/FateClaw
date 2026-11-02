# FateClaw（命枢） · Memory System Dev

[English](#english) · [简体中文](#简体中文)

## English

**Development branch: `feat/cross-conversation-memory`**

This is the development version of FateClaw's cross-conversation memory system, published for testing and review. Behavior and database schema may change as development continues.

FateClaw is an open-source Chinese metaphysics AI agent with deterministic chart calculation, personal knowledge retrieval, and AI interpretation. This branch adds durable memory to its existing Bazi, Ziwei, Qimen, I Ching, and chat workflows.

### Memory features

- Learn facts, preferences, events, plans, and decisions from user statements, with original source evidence.
- Reuse authorized information across conversations through keyword search and topic labels. Manual corrections take precedence; conflicting automatic assertions remain available for review.
- Review, add, edit, and forget memories at `/memory`; control automatic learning, recall, and chat editing, including learning per conversation.
- Keep account owners, WeChat speakers, and discussed clients distinct, with explicit identity binding and sharing controls.
- Import conversation history through background jobs with pause/resume, retries, budgets, and scheduling across accounts. Platform controls are at the owner-only admin `/system/memory` page.

Soul remains the manually maintained persona, separate from automatically learned memory. See [Memory architecture and behavior](docs/memory.md) for the contracts and limitations.

### Try this branch

```bash
git clone --single-branch --branch feat/cross-conversation-memory https://github.com/Coaixy/FateClaw.git
cd FateClaw
```

Follow [Local development](docs/development.md) for Node.js 24, the pinned pnpm version, PostgreSQL, Redis, and model configuration. Background extraction uses the configured official model pool. After setup, use `pnpm run dev`; lightweight/API-only mode skips background memory workers.

Existing accounts upgraded by migration `0102` start with automatic learning disabled; enable it at `/memory` when testing. New accounts follow the platform default.

Use a separate development database for evaluation. Full API startup applies migrations `0102` and `0103`; upgrading existing data requires a backup and a maintenance window because memory backfill holds table locks. Deploy API, agent-runtime, web, admin, and contracts together. See [Deployment](docs/memory.md#deployment).

### Development status

Core behavior has automated coverage with disposable PostgreSQL databases and synthetic model providers. Real-provider extraction accuracy, live WeChat integration, and production-scale latency remain **unverified**.

Recall uses keywords and bounded topic expansion, so it can miss paraphrases outside the supported topics. Forgetting cannot retract text already sent to a provider or written in an assistant reply; use context reset when a fresh model conversation is needed. Original chat history is retained.

Built with TypeScript, Next.js, Fastify, PostgreSQL, Redis, and Pi SDK.

[Memory system](docs/memory.md) · [Local setup](docs/development.md) · [Documentation](docs/README.md) · [Agent guide](AGENT.md) · [Contributing](CONTRIBUTING.md)

For research and personal exploration; not professional advice.

Licensed under [GPL-3.0-only](LICENSE). Copyright (C) 2026 Gavriel.

## 简体中文

**开发分支：`feat/cross-conversation-memory`**

这是 FateClaw 跨对话记忆系统的 **dev 版本**，用于开发、试用和评估。功能行为与数据库结构仍可能随开发调整。

FateClaw（命枢）是一个开源玄学 AI Agent，结合确定性排盘、个人知识库检索和 AI 解读。本分支在八字、紫微斗数、奇门遁甲、易经与聊天功能上加入持久化记忆。

### 记忆功能

- 从用户陈述中学习事实、偏好、经历、计划和决定，保留原话依据。
- 通过关键词与主题标签跨对话召回已授权的信息。人工纠正优先，自动提取的冲突内容保留为待确认记录。
- 在 `/memory` 查看、新增、修改和遗忘记忆，分别控制自动学习、召回、对话编辑，也可逐个设置对话是否参与学习。
- 区分账号本人、微信说话人与讨论中的命主，通过明确绑定和共享开关控制访问。
- 通过后台任务回填历史对话，支持暂停、继续、重试、预算与跨账户轮转调度。平台配置位于仅站长可访问的管理页 `/system/memory`。

Soul 仍由用户手动维护人格与表达偏好，与自动学习的记忆分开。详细行为和边界见[记忆系统说明](docs/memory.md)。

### 试用此分支

```bash
git clone --single-branch --branch feat/cross-conversation-memory https://github.com/Coaixy/FateClaw.git
cd FateClaw
```

按照[本地开发指南](docs/development.md)配置 Node.js 24、项目固定版本的 pnpm、PostgreSQL、Redis 和模型。后台记忆提取使用已配置的官方模型池。完成配置后运行 `pnpm run dev`；轻量/API-only 模式不会启动后台记忆任务。

经过 `0102` 升级的已有账号默认关闭自动学习，试用时可在 `/memory` 开启；新账号遵循后台默认设置。

试用时使用独立的开发数据库。完整 API 启动会执行 `0102`、`0103` 迁移；升级已有数据前需要备份并安排维护窗口，记忆回填期间会持有表锁。API、agent-runtime、用户端、管理端与 contracts 需一起部署，详见[部署说明](docs/memory.md#deployment)。

### 开发状态

关键链路已有自动化测试覆盖，数据库验证使用一次性 PostgreSQL，模型调用使用合成接口。**真实模型提取准确率、真实微信全链路和生产规模延迟仍未验证。**

当前召回依赖关键词与有限主题扩展，超出覆盖范围的改写仍可能漏召回。遗忘无法撤回已经发送给模型或写入助手回复的内容；需要全新模型上下文时，可同时重设会话上下文。原始聊天记录会保留。

使用 TypeScript、Next.js、Fastify、PostgreSQL、Redis 和 Pi SDK 构建。

[记忆系统](docs/memory.md) · [本地开发](docs/development.md) · [项目文档](docs/README.md) · [Agent 指南](AGENT.md) · [贡献指南](CONTRIBUTING.md)

仅供研究和个人探索，不构成专业建议。

采用 [GPL-3.0-only](LICENSE) 许可证。版权所有 (C) 2026 Gavriel。
