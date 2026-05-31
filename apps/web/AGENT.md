# Web 前端

这是一个基于 Next.js 16 App Router 的控制台前端。它不是单纯营销站，主要是业务控制台和管理后台。

## 从哪里看起

第一次接手前端时，建议按这个顺序看：

1. `apps/web/app/layout.tsx`
2. `apps/web/app/page.tsx`
3. `apps/web/features/auth/api.ts`
4. `apps/web/features/auth/hooks/use-auth.ts`
5. `apps/web/components/app-shell.tsx`
6. `apps/web/components/sidebar.tsx`
7. `apps/web/components/ai-chat/ai-chat-workspace.tsx`

如果是后台相关，再看：

1. `apps/web/app/admin/page.tsx`
2. `apps/web/app/admin/(dashboard)/layout.tsx`
3. `apps/web/components/admin-sidebar.tsx`
4. `apps/web/lib/admin-api.ts`

## 结构

```text
apps/web/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── login/page.tsx
│   ├── dashboard/page.tsx
│   ├── chat/page.tsx
│   ├── ai-chat/page.tsx
│   ├── devices/page.tsx
│   ├── discover/page.tsx
│   ├── plans/page.tsx
│   ├── profile/page.tsx
│   ├── wallet/page.tsx
│   ├── studio/
│   ├── tasks/page.tsx
│   ├── settings/page.tsx
│   ├── skills/install/page.tsx
│   ├── skills/bundle/install/page.tsx
│   └── admin/
├── components/
│   ├── app-shell.tsx
│   ├── sidebar.tsx
│   ├── admin-*.tsx
│   ├── chat/*.tsx
│   └── ui/*.tsx
├── lib/
│   ├── admin-api.ts
│   ├── http/client.ts
│   ├── use-confirm.ts
│   ├── use-theme.ts
│   └── use-toast.ts
├── features/
│   ├── auth/
│   ├── accounts/
│   ├── billing/
│   ├── chat/
│   ├── paipan/
│   ├── skills/
│   └── tasks/
└── utils/
```

## 开发与生产差异

- 开发态：根目录 `pnpm run dev` 同时启动 API + Web；只跑 Web 用 `pnpm run dev:web`
- Next dev server 跑在 `3001`
- 开发态 API 通过 `apps/web/next.config.ts` rewrites 转发到 `http://localhost:3000/api/*`
- 生产态：`next build` 后静态导出到 `apps/web/out/`
- 生产态最终由宿主 Fastify 托管，不是单独部署 Next server

排查“本地正常、线上不正常”时，先确认问题是出在：

- Next 开发模式
- 静态导出结果
- Fastify 托管与回退规则

## 关键模块

### 路由页面

- `app/page.tsx`: 首页 / 入口页
- `app/login/page.tsx`: 登录注册
- `app/dashboard/page.tsx`: 账号总览、绑定、Soul、计划和主要入口
- `app/chat/page.tsx`: 聊天记录页
- `app/ai-chat/page.tsx`: Web 侧 AI 聊天界面
- `app/tasks/page.tsx`: 定时任务
- `app/discover/page.tsx`: Skill 市场发现页
- `app/studio/*`: 创作者工作台、Skill 和 Bundle 创建编辑
- `app/skills/install/page.tsx`: 单个 Skill 安装页
- `app/skills/bundle/install/page.tsx`: Bundle 安装页
- `app/wallet/page.tsx`: 钱包与充值
- `app/devices/page.tsx`: 设备与账号绑定入口
- `app/plans/page.tsx`: 会员 / Token Plan 预留页
- `app/profile/page.tsx`: 个人资料
- `app/settings/page.tsx`: 设置
- `app/admin/*`: 管理后台

### API 封装

- `lib/admin-api.ts`: 管理后台 API client
- `features/*/api.ts`: 普通用户各业务域 API client
- `features/paipan/api.ts`: 直排盘 API client
- `features/auth/hooks/use-auth.ts`: 登录态 hook
- `features/auth/providers/auth-provider.tsx`: 认证上下文

如果后端接口变更，前端这里通常要同步改。

## UI 特征

- 当前样式不是保守后台模板，页面视觉较强，尤其首页和 dashboard
- CSS 变量和 `globals.css` 承担了较多主题职责
- 组件里存在不少动画、渐变和视觉状态，不要在小改动时无意抹平整体风格

## 改动约定

- 优先复用已有 `features/*/api.ts` / `lib/admin-api.ts`，不要在页面内散落原始 `fetch`
- 登录态逻辑优先走现有 auth hooks / provider
- 调路由时同时检查桌面侧栏、移动导航和入口页是否受影响
- 如果接口字段变更，检查日志页、技能页和 dashboard，这几个页面依赖最重
- 当前仓库不保留测试源文件；前端改动后至少跑 `pnpm --filter fateclaw-web exec tsc --noEmit`，必要时再跑 `pnpm --filter fateclaw-web build`

## 安全部署要求（必读）

由于使用 `output: 'export'` 静态导出，Next.js **没有运行时 middleware**，admin 路由的鉴权完全在客户端。生产部署必须在反向代理层（Nginx / Caddy / Traefik）实施额外保护：

1. **管理后台 IP 白名单**：路径 `/admin/*` 必须限制到运维办公网 IP / VPN，否则 admin 入口暴露在公网
2. **API 后端 CORS 白名单**：宿主侧已通过 `ALLOWED_ORIGINS` env 强制白名单（缺失时拒绝启动）
3. **JWT 与 admin_key 存储**
   - 用户 JWT 存于 `localStorage`，依赖严格 CSP 防 XSS（建议反代加 `Content-Security-Policy: default-src 'self'`）
   - admin_key 存于 `sessionStorage`（关闭 tab 即清除），缩短持久化窗口
4. **HTTPS 强制**：反代应做 HTTP→HTTPS 301，避免 token 明文传输

不满足以上任一项时不应上线 admin 路由。
