# FateClaw（命枢）

FateClaw 是一个开源玄学 Agent 系统，核心能力是“本地排盘 + 用户知识库检索 + Pi Runtime 解读”。它不是把大模型套在一个聊天框里，而是把术数排盘、知识沉淀、模型调用、工具执行、对话留痕和微信 OpenClaw/iLink 接入拆成清晰的运行时边界。

当前可用主链路是站内 AI Chat、手动排盘和用户知识库检索。微信 OpenClaw/iLink Bot 对接代码仍保留，但默认启动入口暂时关闭微信设备 listener/poller，恢复接入前需要重新确认外部平台协议和部署安全边界。

> 本项目内容仅用于软件工程、排盘工具和个人研究场景，不构成医疗、法律、投资或其他专业建议。

## 项目亮点

- **本地确定性排盘**：八字、紫微、奇门、六爻、经占等官方 Skill 以本地脚本执行，先生成结构化盘面，再交给 Agent 承接。
- **用户知识库检索**：创作者可以把流派规则、案例边界、固定口径拆成章节，解读 Agent 按需读取，不把整本资料塞进上下文。
- **常驻 Agent Runtime**：宿主通过 Redis IPC 调度账号级 `agent-runner` 常驻进程，避免每条消息重新初始化完整运行环境。
- **Pi Runtime 编排**：模型 loop、工具选择、Skill 文件读取和最终回复都由 Pi SDK 承接，FateClaw 只保留领域 custom tools。
- **请求级模型配置**：模型 Provider、密钥、价格和上下文窗口由宿主解析成 `llmRuntime` 快照随请求下发，不依赖 agent 进程全局模型环境变量。
- **可观测对话链路**：每次请求返回 transcript、trace events、agent graph 和 token usage，后台可回看工具调用、知识命中和模型链路。
- **OpenClaw/iLink 预留接入**：微信账号、消息转换、轮询和发送路径仍在仓库内，适合在站内主链路稳定后恢复外部渠道。

## 系统总览

```mermaid
flowchart LR
  subgraph Client["用户入口"]
    Web["Web 控台<br/>AI Chat / 手动排盘 / 知识库"]
    WeChat["微信 OpenClaw/iLink<br/>当前默认关闭"]
  end

  subgraph Host["apps/api 宿主进程"]
    Fastify["Fastify API"]
    Session["会话 / 消息 / 账号"]
    Runtime["模型配置解析<br/>llmRuntime 快照"]
    Billing["计费 / 用量 / 后台"]
    IpcWorker["Redis IPC Worker"]
  end

  subgraph Redis["Redis IPC"]
    Inbox["ipc:{runtimeId}:inbox"]
    Outbox["ipc:{runtimeId}:outbox"]
    AiOutbox["ipc:{runtimeId}:ai-chat:outbox"]
    TaskQueue["ipc:{runtimeId}:tasks"]
  end

  subgraph Agent["packages/agent-runner 常驻进程"]
    Daemon["daemon BRPOP"]
    Kernel["Pi Runtime"]
    Tools["Pi Custom Tools / Skill Resources"]
  end

  subgraph Data["数据与能力"]
    PG[("PostgreSQL<br/>用户 / 会话 / 知识库 / 日志 / 账务")]
    OfficialSkills["skills/official<br/>本地排盘 Skill"]
    LLM["模型 Provider<br/>OpenAI / Anthropic / Gemini / Compatible"]
  end

  Web --> Fastify
  WeChat -.-> Fastify
  Fastify --> Session
  Fastify --> Runtime
  Fastify --> Billing
  Session --> PG
  Runtime --> IpcWorker
  IpcWorker --> Inbox
  Inbox --> Daemon
  Daemon --> Kernel
  Kernel --> Tools
  Tools --> OfficialSkills
  Tools --> PG
  Kernel --> LLM
  Daemon --> Outbox
  Daemon --> AiOutbox
  Outbox --> IpcWorker
  AiOutbox --> IpcWorker
  TaskQueue --> IpcWorker
  IpcWorker --> PG
  Fastify --> Web
```

当前稳定主链路是 Web AI Chat。微信接入相关代码路径仍保留，但默认入口未启用。

## Pi Runtime

FateClaw 的 Agent 执行已统一到 Pi SDK：宿主只负责请求、账务、权限和日志，agent-runner 每次请求创建 request-scoped Pi Runtime，把当前用户有权访问的官方 Skill 与 Text Skill Bundle 暴露给 Pi ResourceLoader。

```mermaid
flowchart TD
  UserMsg["用户消息 / 手动排盘 / 自贴盘面"] --> Runtime["createRequestRuntime"]
  Runtime --> Loader["Pi ResourceLoader<br/>官方 SKILL.md + request-scoped Text Skill Bundle"]
  Loader --> Session["Pi Session<br/>模型自主选择工具和读取 Skill 文件"]
  Session --> Board["确定性排盘工具<br/>bazi_paipan / iching_paipan / ..."]
  Session --> ReadSkill["read_skill_file<br/>读取 SKILL.md / index.md / docs / examples / notes"]
  Session --> Interpret["interpret_xuanxue<br/>结合盘面、问题和授权知识解读"]
  Board --> Artifact["结构化盘面 artifact"]
  Artifact --> Interpret
  Interpret --> Trace["transcript / traceEvents / agentGraph / usage"]
  ReadSkill --> Interpret
```

## 一次请求如何完成

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web
  participant H as apps/api Host
  participant R as Redis IPC
  participant A as agent-runner
  participant S as Local Skills / Knowledge
  participant M as Model Provider
  participant DB as PostgreSQL

  U->>W: 发送问题或提交排盘
  W->>H: POST /api/chat-sessions 或 /api/paipan
  H->>DB: 写入用户消息 / 会话状态
  H->>H: AI 请求解析 llmRuntime；手动排盘只构造 Pi paipan IPC
  H->>R: LPUSH ipc:{runtimeId}:inbox
  A->>R: BRPOP inbox
  A->>A: 创建 request-scoped Pi Runtime
  A->>S: 暴露官方 Skill 与授权 Text Skill Bundle
  A->>M: AI 请求通过 Pi SDK 调用模型和工具
  M-->>A: tool call / final reply
  A->>S: 手动排盘通过 Pi deterministic tool 执行
  A->>R: LPUSH ai-chat outbox
  H->>R: 监听 outbox
  H->>DB: 写入回复、trace、agentGraph、usage、账务记录
  H-->>W: 返回最终回复和查询过程
  W-->>U: 展示解读、盘面和知识检索轨迹
```

## 关键能力

| 能力 | 当前实现 |
| --- | --- |
| 排盘 | Pi custom tools 调用 `skills/official/*-paipan/paipan.js`，返回结构化 artifact |
| 解读 | Pi custom tool `interpret_xuanxue`，自动注入当前盘面和授权用户知识 |
| 用户知识库 | Web 创建 Text Skill Bundle，DB 只存 metadata、权限、版本和 `bundle_uri` |
| Agent 调度 | `packages/agent-runner/src/pi-runtime/` 通过 Pi SDK 统一处理模型 loop、工具调用和 Skill 文件读取 |
| IPC | Redis list 队列：inbox、outbox、ai-chat outbox、tasks |
| 模型 | AI 请求使用请求级 `llmRuntime` 快照，由 Pi Runtime 适配 OpenAI-compatible、OpenAI Responses、Anthropic、Gemini |
| 可观测性 | `conversation_logs` 保存 transcript、traceEvents、agentGraph、usage |
| 微信接入 | OpenClaw/iLink 代码路径保留，默认入口暂时关闭 |

## 技术栈

- Monorepo: pnpm workspace
- API: Fastify + PostgreSQL + Redis
- Agent Runner: TypeScript daemon + Redis IPC + Pi SDK Runtime
- Web: Next.js 16 App Router + React 19
- 测试与质量：Vitest、TypeScript、ESLint、Prettier

## 目录结构

```text
FateClaw/
├── apps/
│   ├── api/                 # 宿主运行时、Fastify API、数据库和 Redis 编排
│   └── web/                 # Next.js 控台
├── packages/
│   ├── agent-runner/        # 常驻 Agent 执行进程、模型循环、工具和 Skill 调用
│   └── contracts/           # 前后端共享 DTO 类型
├── skills/
│   ├── official/            # 官方排盘和解读 Skill
│   └── _template/           # Skill 模板
├── docs/                    # API、Agent 架构、OpenClaw 对接等文档
├── scripts/                 # 初始化、清理和打包脚本
└── .env.example             # 环境变量示例
```

## 快速开始

### 前置依赖

- Node.js 20+
- pnpm 9+
- Docker（推荐，用于启动本地 PostgreSQL / Redis；也可自行安装这两个服务）
- 至少一个可用的大模型 API Key

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动本地基础设施

```bash
docker compose up -d
```

该命令只启动开发所需的 PostgreSQL 和 Redis，不会启动 API 或 Web。PostgreSQL 容器会自动创建 `fateclaw` 数据库；API 首次启动时会自动创建和补齐所需表结构。

### 3. 准备环境变量

```bash
cp .env.example .env
```

最小本地配置建议先填写：

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/fateclaw
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=replace-with-strong-random-secret-at-least-32-chars
MANAGER_KEY=replace-with-strong-random-admin-key-at-least-32-chars
ALLOWED_ORIGINS=http://localhost:3001
```

说明：

- `JWT_SECRET` 和 `MANAGER_KEY` 必须使用强随机值，可用 `openssl rand -hex 32` 生成。
- `SKILLS_DIR` 可选，用于显式指定官方 Skill 根目录，例如 Windows 服务部署可设为 `C:\apps\FateClaw\skills\official`，避免服务启动目录变化时误报排盘脚本不存在。
- 注册和找回密码依赖阿里云短信验证码；本地开发如不接短信服务，可先通过数据库插入测试用户或临时接入自己的短信配置。
- 模型 Provider 主要通过管理后台写入数据库配置。
- `DATABASE_URL` 需要指向一个已存在且可连接的 PostgreSQL 库；API 首次启动会自动创建和补齐所需表结构，无需手动执行 `scripts/init-pg.sql`。

### 4. 启动开发环境

```bash
pnpm run dev
```

默认端口：

- API: `http://localhost:3000`
- Web: `http://localhost:3001`

常用开发命令：

```bash
pnpm run dev           # 宿主 API + Web
pnpm run dev:light     # 轻量 API + Web，跳过部分运行时后台任务
pnpm run dev:api       # 仅宿主 API
pnpm run dev:api-only  # 仅轻量 API
pnpm run dev:web       # 仅 Web
pnpm run typecheck     # 全 workspace 类型检查
pnpm run lint          # API lint
pnpm test              # Vitest 测试
pnpm run build:all     # 构建 API、agent-runner 和 Web
```

## 首次配置模型

站内 AI Chat 需要可用模型配置。当前推荐通过管理后台配置官方模型：

1. 设置 `.env` 中的 `MANAGER_KEY` 并启动服务。
2. 打开 `http://localhost:3001/admin`。
3. 输入 `MANAGER_KEY` 进入后台。
4. 在系统配置中新增模型 Provider，填写协议、Base URL、模型名和 API Key。
5. 普通用户在设置页选择官方模型或保存自配模型。

AI 请求会携带请求级 `llmRuntime` 快照给 `agent-runner`，模型密钥不依赖 agent 进程级环境变量；手动排盘请求不需要模型 runtime，只通过 Pi deterministic tool 执行。

## Skill 与知识库

官方 Skill 位于 [skills/official](skills/official)：

- `bazi-paipan`：八字排盘
- `ziwei-paipan`：紫微斗数排盘
- `qimen-paipan`：奇门遁甲排盘
- `iching-paipan`：六爻纳甲排盘
- `jingzhan-paipan`：周易经占排盘
- `xuanxue-jiedu`：玄学解读入口工具

部署时如果官方 Skill 不在默认仓库结构下，可通过 `SKILLS_DIR` 指向 `skills/official` 目录本身。

用户知识库由 Web 控台创建为 `.fateclaw/text-skills/<owner>/<dir>-<id>/` 下的 Text Skill Bundle，包含 `SKILL.md`、`index.md`、`docs/`、`examples/` 和 `notes/`。数据库只保存 metadata、权限、版本、安装状态和 `bundle_uri`；运行时每次请求只把当前用户有权访问的 Bundle 注入 Pi ResourceLoader，模型再按需读取 Markdown 文件或知识章节。

## 微信 OpenClaw/iLink 对接状态

仓库保留了微信 OpenClaw/iLink 对接相关模块，包括账号管理、扫码登录、消息转换、消息发送和轮询处理。当前默认入口中微信设备 listener/poller 暂时关闭，因此：

- 站内 AI Chat 和手动排盘可以作为当前主链路运行。
- 微信账号绑定 UI 和部分设备能力可能显示为暂时关闭。
- 若要恢复微信链路，需要重新启用入口编排，并确认 OpenClaw/iLink Bot API 的可用性和部署安全边界。

详细说明见 [docs/openclaw-integration.md](docs/openclaw-integration.md)。

## 文档索引

- [docs/agent-architecture.md](docs/agent-architecture.md)：Agent 运行架构、Redis IPC、Pi Runtime 和 request-scoped Skill 资源。
- [docs/api-reference.md](docs/api-reference.md)：HTTP API 参考。
- [docs/openclaw-integration.md](docs/openclaw-integration.md)：微信 OpenClaw/iLink 对接边界。
- [DESIGN.md](DESIGN.md)：产品和设计上下文。
- [AGENT.md](AGENT.md)：给代码协作者和 AI Agent 的仓库入口说明。
- [CONTRIBUTING.md](CONTRIBUTING.md)：贡献指南。
- [SECURITY.md](SECURITY.md)：安全策略和漏洞报告方式。

## 开源协议

FateClaw 使用 GNU General Public License v3.0 开源，详见 [LICENSE](LICENSE)。

Copyright (C) 2026 Gavriel.

这意味着你可以使用、复制、修改和分发本项目，但分发修改版本或派生作品时需要遵守 GPLv3 的源代码开放和同协议要求。第三方依赖仍适用其各自许可证。
