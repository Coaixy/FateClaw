# FateClaw 文档索引

最近核对：2026-06-29。

> 本目录只保留**当前有效的常驻文档**。已完成使命的一次性产物（迁移方案、code review、
> 改进计划、安全报告、历史设计草案）统一移到 [`archive/`](./archive/)，仅作历史留痕，
> **不反映现状**。

## 常驻文档

| 文档 | 用途 |
| --- | --- |
| [membership-entitlement-current.md](./membership-entitlement-current.md) | 会员权益与 AI 解读门禁的**单一事实来源**：单层化（只剩 Clarity）、非会员一律 403、metered 两阶段计费 |
| [api-reference.md](./api-reference.md) | 站内 HTTP API 总参考（auth / chat / paipan / billing 等） |
| [open-api-design.md](./open-api-design.md) | 对外开放 API（`/api/v1`、`/api/open-sessions`）设计与实现说明 |
| [bazi-cases-open-api.md](./bazi-cases-open-api.md) | 八字命例数据集对外查询 API（免鉴权、限流） |
| [agent-architecture.md](./agent-architecture.md) | Agent 运行时核心架构：IPC 队列、local-runner、宿主会话链路 |
| [deployment-split.md](./deployment-split.md) | www / admin / api 三站点部署手册 |
| [openclaw-integration.md](./openclaw-integration.md) | 微信 OpenClaw/iLink 链路（当前整体停用）的现状与恢复边界 |

## archive/（历史归档，勿据此判断现状）

| 文档 | 为何归档 |
| --- | --- |
| membership-tier-migration.md | 四档迁移方案；后又单层化，整体作废（顶部有横幅） |
| api-membership-billing-cleanup.md | 计费清理方案；档位部分作废，钱包/计费命名规范仍可参考（顶部有横幅） |
| admin-improvement-modification-plan-2026-06-17.md | admin 改进计划，P0/P1 已落地 |
| code-review-2026-06-16.md / -fix-plan.md | 一次性深度扫描报告与修复方案 |
| apps-web-security-fix-report-2026-05-31.md | 一次性安全修复报告 |
| spark/onboarding-guide-design.md | 启动向导设计，已实现（历史记录） |
| spark/announcements-design.md | 公告系统设计，已实现（历史记录） |
| spark/simple-mode-workflows-design.md | 简易模式 workflow 设计，**功能已删除，勿参考** |
| spark/international-billing-model-design.md | 计费心智设计，**前提「会员免费额度」已废弃，勿参考** |
