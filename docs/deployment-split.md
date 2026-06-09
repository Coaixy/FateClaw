# www / admin / api 三站点部署

FateClaw 生产环境推荐拆成三个独立站点：

```text
https://www.example.com      -> www 用户静态站点（apps/web）
https://admin.example.com    -> admin 管理静态站点（apps/admin）
https://api.example.com      -> Fastify API（apps/api）
```

www 和 admin 都通过 `NEXT_PUBLIC_API_BASE=https://api.example.com` 调用 API。
API 生产环境必须把两个前端来源都加入 `ALLOWED_ORIGINS`：

```dotenv
ALLOWED_ORIGINS=https://www.example.com,https://admin.example.com
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_WEB_BASE_URL=https://www.example.com
```

admin 是静态站点，不能替代服务端鉴权；生产环境仍建议在反向代理层为
`admin.example.com` 增加 IP 白名单、VPN 或额外认证。

支付回调也按三站点拆分：易支付异步通知 `notify_url` 指向
`https://api.example.com/api/billing/recharge/notify`，用户支付完成后的
`return_url` 指向 `https://www.example.com/wallet`。

## 打包

```bash
pnpm run pack
```

默认会生成三个包：

```text
fateclaw-backend-v<version>-runtime.tar.gz
fateclaw-www-v<version>-static.tar.gz
fateclaw-admin-v<version>-static.tar.gz
```

也可以单独打包：

```bash
bash scripts/pack.sh backend-runtime
bash scripts/pack.sh backend-source
bash scripts/pack.sh backend
bash scripts/pack.sh www
bash scripts/pack.sh admin
```

旧参数 `api-runtime`、`api-source`、`api` 仍是后端包兼容别名；旧参数 `web`
仍兼容为 `www` 静态包。

## API 部署

生产环境推荐使用后端 runtime 包。它已经包含 `apps/api/dist` 和
`apps/agent-runtime/dist`，服务器不需要再执行 TypeScript 构建。
包内 `.npmrc` 会设置 `package-lock=false`，避免 1Panel 旧项目目录里残留的
`package-lock.json` 影响本次安装。

```bash
mkdir -p fateclaw-api
tar xzf fateclaw-backend-v<version>-runtime.tar.gz --strip-components=1 -C fateclaw-api
cd fateclaw-api
npm install --omit=dev -f
npm run start
```

在 1Panel 的 Node.js 运行环境中，启动命令可填写：

```bash
npm install --omit=dev -f && npm run start
```

2G 内存服务器建议在 1Panel / Docker 中额外设置：

- FateClaw API 容器内存限制：`768MiB`
- FateClaw API 容器 `pids_limit`：`128`
- PostgreSQL、Redis 单独设置资源限制，避免和 agent-runtime 抢占同一上限
- 首次部署带 runtime 回收能力的版本前，手动清理旧的 `agent-runtime` 孤儿进程

生产 `.env` 建议包含：

```bash
NODE_ENV=production
LOCAL_AGENT_ENTRY_MODE=dist
LOG_PRETTY=0
LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB=128
ALLOWED_ORIGINS=https://www.example.com,https://admin.example.com
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_WEB_BASE_URL=https://www.example.com
```

Agent 并发槽位、常驻 runtime 上限和空闲回收时间在管理后台写入数据库。
2G 服务器可先使用 `1` 并发、`2` 个常驻 runtime、`120` 秒空闲回收。

如需在服务器上重新构建源码包，可使用 `bash scripts/pack.sh api` 生成
`fateclaw-backend-v<version>-source.tar.gz`，部署时执行
`pnpm install && pnpm run build && pnpm run start`。

## www 部署

```bash
mkdir -p /var/www/fateclaw-www
rm -rf /var/www/fateclaw-www/*
tar xzf fateclaw-www-v<version>-static.tar.gz -C /var/www/fateclaw-www
```

www 包内就是用户静态站点根目录内容，包含 `index.html`、`_next/static/*`
和各页面目录。部署时必须先清空目标目录再解压，避免已删除或改名的旧页面、
旧路由数据继续留在线上。

## admin 部署

```bash
mkdir -p /var/www/fateclaw-admin
rm -rf /var/www/fateclaw-admin/*
tar xzf fateclaw-admin-v<version>-static.tar.gz -C /var/www/fateclaw-admin
```

admin 包内是独立管理站点，登录页位于站点根路径 `/`，管理页面位于
`/overview`、`/users`、`/system/models` 等路径。

## Nginx 示例

```nginx
server {
  listen 80;
  server_name api.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 80;
  server_name www.example.com;
  root /var/www/fateclaw-www;

  location ^~ /_next/static/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
  }

  location / {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    try_files $uri $uri/ /index.html;
  }
}

server {
  listen 80;
  server_name admin.example.com;
  root /var/www/fateclaw-admin;

  # 生产环境建议在这里增加 allow/deny、Basic Auth 或 VPN 入口控制。
  location ^~ /_next/static/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
  }

  location / {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    try_files $uri $uri/ /index.html;
  }
}
```

如果部署了 HTTPS，把 `listen` 和证书配置加到对应 server 内即可。

缓存策略说明：

- `/_next/static/*` 文件名带构建 hash，内容变化后 URL 会变，可以长缓存一年并加 `immutable`。
- 页面入口、`*.html` 和 Next App Router 静态导出的 `*.txt` 路由数据不能长缓存，否则浏览器或 CDN 会继续拿旧页面壳和旧路由数据。
- 如果用了 CDN，还需要在 CDN 侧对页面入口、HTML/TXT 禁用缓存或部署后主动刷新缓存。
