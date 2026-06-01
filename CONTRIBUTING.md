# 贡献指南

感谢你关注 FateClaw。这个仓库当前更适合以小步、可验证的方式推进：修复具体问题、补齐测试、完善文档、增加明确边界内的 Skill 或接入能力。

## 开始之前

请先阅读：

- [README.md](README.md)：项目定位、快速开始和运行边界。
- [docs/agent-architecture.md](docs/agent-architecture.md)：Agent、Redis IPC、Pi Runtime 和 request-scoped Skill 资源。
- [docs/api-reference.md](docs/api-reference.md)：HTTP API 参考。
- [docs/openclaw-integration.md](docs/openclaw-integration.md)：微信 OpenClaw/iLink 对接现状。
- [AGENT.md](AGENT.md)：面向协作者和 AI Agent 的仓库入口说明。

如果你要修改前端，也请读 [apps/web/AGENT.md](apps/web/AGENT.md)。如果你要改 API 路由，也请读 [apps/api/src/interfaces/http/AGENT.md](apps/api/src/interfaces/http/AGENT.md)。

## 本地开发

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm run dev
```

本地基础设施至少需要 PostgreSQL 和 Redis；推荐直接用仓库内的 `docker-compose.yml` 启动。API 首次启动会自动创建和补齐所需表结构，无需手动执行 `scripts/init-pg.sql`。

## 分支和提交

- 一个 Pull Request 只解决一个清晰问题。
- 不把格式化、重命名、目录迁移和功能改动混在一起。
- 不提交 `.env`、私钥、模型 API Key、OpenClaw/iLink token、数据库导出或用户聊天记录。
- 如果改动涉及 GPLv3 以外许可证的代码或素材，请在 PR 中说明来源和许可证。

## 修改原则

- 优先复用现有模块和风格，避免为一次性需求增加抽象。
- 修改 API 契约时，同步检查 `packages/contracts`、前端 API client 和 `docs/api-reference.md`。
- 修改 Agent 能力时，同步检查 `apps/agent-runtime/src/pi-runtime/`、官方 `SKILL.md`、Text Skill Bundle 读取逻辑和相关测试。
- 修改排盘 Skill 时，保留本地确定性计算，不把排盘基础结果改成纯模型生成。
- 修改微信 OpenClaw/iLink 相关代码时，必须说明影响的是既有账号后端轮询、新扫码绑定入口、自动发送链路还是部署前置条件。

## 测试与验证

提交前至少执行和改动相关的检查：

```bash
pnpm run typecheck
pnpm run lint
pnpm test
```

可按范围缩小命令：

```bash
pnpm --filter @fateclaw/api typecheck
pnpm --filter @fateclaw/agent-runtime exec tsc --noEmit
pnpm --filter fateclaw-web exec tsc --noEmit
pnpm --filter fateclaw-web build
```

文档改动请至少检查 Markdown 链接、命令和路径是否仍然存在。

## Pull Request 内容

PR 描述建议包含：

- 这次解决什么问题。
- 主要改动点。
- 已运行的验证命令。
- 未验证的部分和原因。
- 是否影响数据库、环境变量、模型 Provider、OpenClaw/iLink 或 GPLv3 许可证边界。

仓库已有 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)，提交 PR 时请按模板勾选类型并补充说明。

## 安全问题

安全漏洞不要直接公开提交 Issue。请按 [SECURITY.md](SECURITY.md) 中的方式报告。
