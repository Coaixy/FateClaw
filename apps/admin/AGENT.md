# Admin 管理站点

这是一个基于 Next.js 16 App Router 的独立管理后台静态站点。它和 `apps/web`
分开构建、分开部署，生产环境建议部署到 `admin.example.com`。

## 从哪里看起

第一次接手管理后台时，建议按这个顺序看：

1. `apps/admin/app/layout.tsx`
2. `apps/admin/app/page.tsx`
3. `apps/admin/app/(dashboard)/layout.tsx`
4. `apps/admin/components/admin-sidebar.tsx`
5. `apps/admin/lib/admin-api.ts`
6. `apps/admin/lib/admin-navigation.ts`

## 路由约定

admin 站点以域名根路径作为登录页：

- `/`: 管理登录页
- `/overview`: 总览
- `/billing`: 账单管理
- `/users`: 用户
- `/messages`: 消息
- `/skills`: 技能
- `/issues`: issue management and private account attribution
- `/workflows`: Workflow
- `/logs`: 日志
- `/system/models`: 模型配置
- `/system/rewards`: 软妹币配置

后端 `/api/admin/verify` 仍可能返回历史路径 `/admin/overview` 或 `/admin/users`。
`apps/admin/lib/admin-navigation.ts` 会把旧路径转换为本站根路径，不要在页面里手写兼容逻辑。

## 开发与生产差异

- 开发态：`pnpm run dev:admin` 启动在 `http://localhost:3002`
- 开发态 API 通过 `apps/admin/next.config.ts` rewrites 转发到 `http://localhost:3000/api/*`
- 生产态：`next build` 后静态导出到 `apps/admin/out/`
- 生产态需要设置 `NEXT_PUBLIC_API_BASE=https://api.example.com`，或者由反向代理为 admin 站点代理 `/api/*`

## 安全部署要求

admin 是静态导出站点，前端页面本身不是安全边界。生产部署必须满足：

1. `/api/admin/*` 继续依赖后端 `X-Admin-Key` 鉴权。
2. `admin.example.com` 建议增加 IP 白名单、VPN、Basic Auth 或其他入口保护。
3. API 的 `ALLOWED_ORIGINS` 必须包含 admin 站点来源。
4. 管理密钥只应由管理员输入，不要编译进前端环境变量或静态文件。
5. 强制 HTTPS，避免管理密钥明文传输。
