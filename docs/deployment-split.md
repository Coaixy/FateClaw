# 前后端分离部署

FateClaw 生产环境推荐使用同域名路径分离：

```text
https://example.com/        -> Web 静态站点
https://example.com/api/*   -> Fastify API
```

这样浏览器仍然同源访问 `/api/*`，不需要额外配置跨域和 Cookie 域名。

## 打包

```bash
pnpm run pack
```

默认会生成两个包：

```text
fateclaw-backend-v<version>-runtime.tar.gz
fateclaw-web-v<version>-static.tar.gz
```

也可以单独打包：

```bash
bash scripts/pack.sh backend-runtime
bash scripts/pack.sh backend-source
bash scripts/pack.sh backend
bash scripts/pack.sh web
```

旧参数 `api-runtime`、`api-source`、`api` 仍是兼容别名，但新文档统一称为后端包。

## 后端部署

生产环境推荐使用后端 runtime 包。它已经包含 `apps/api/dist` 和
`apps/agent-runtime/dist`，服务器不需要再执行 TypeScript 构建。
包内 `.npmrc` 会设置 `package-lock=false`，避免 1Panel 旧项目目录里残留的
`package-lock.json` 影响本次安装。

```bash
mkdir -p fateclaw
tar xzf fateclaw-backend-v<version>-runtime.tar.gz --strip-components=1 -C fateclaw
cd fateclaw
npm install --omit=dev -f
npm run start
```

在 1Panel 的 Node.js 运行环境中，启动命令可填写：

```bash
npm install --omit=dev -f && npm run start
```

2G 内存服务器建议在 1Panel / Docker 中额外设置：

- FateClaw 后端容器内存限制：`768MiB`
- FateClaw 后端容器 `pids_limit`：`128`
- PostgreSQL、Redis 单独设置资源限制，避免和 agent-runtime 抢占同一上限
- 首次部署带 runtime 回收能力的版本前，手动清理旧的 `agent-runtime` 孤儿进程

生产 `.env` 建议只保留部署和进程启动类配置，例如：

```bash
NODE_ENV=production
LOCAL_AGENT_ENTRY_MODE=dist
LOG_PRETTY=0
LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB=128
```

Agent 并发槽位、常驻 runtime 上限和空闲回收时间在管理后台写入数据库。
2G 服务器可先使用 `1` 并发、`2` 个常驻 runtime、`120` 秒空闲回收。

如需在服务器上重新构建源码包，可使用 `bash scripts/pack.sh api` 生成
`fateclaw-backend-v<version>-source.tar.gz`，部署时执行
`pnpm install && pnpm run build && pnpm run start`。

## Web 部署

```bash
mkdir -p /var/www/fateclaw-web
rm -rf /var/www/fateclaw-web/*
tar xzf fateclaw-web-v<version>-static.tar.gz -C /var/www/fateclaw-web
```

Web 包内就是静态站点根目录内容，包含 `index.html`、`_next/static/*` 和各页面目录。
部署时必须先清空目标目录再解压，避免已删除或改名的旧页面、旧路由数据继续留在线上。

## Nginx 示例

```nginx
server {
  listen 80;
  server_name example.com;
  root /var/www/fateclaw-web;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location ^~ /_next/static/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
  }

  location ~* \.(?:html|txt)$ {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    add_header CDN-Cache-Control "no-store" always;
    add_header Surrogate-Control "no-store" always;
    add_header Pragma "no-cache" always;
    add_header Expires "0" always;
    try_files $uri $uri/ /index.html;
  }

  location / {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    add_header CDN-Cache-Control "no-store" always;
    add_header Surrogate-Control "no-store" always;
    add_header Pragma "no-cache" always;
    add_header Expires "0" always;
    try_files $uri $uri/ /index.html;
  }
}
```

如果部署了 HTTPS，把 `listen` 和证书配置加到同一个 server 内即可。

缓存策略说明：

- `/_next/static/*` 文件名带构建 hash，内容变化后 URL 会变，可以长缓存一年并加 `immutable`。
- 页面入口、`*.html` 和 Next App Router 静态导出的 `*.txt` 路由数据不能长缓存，否则浏览器或 CDN 会继续拿旧页面壳和旧路由数据。
- 如果用了 CDN，还需要在 CDN 侧对页面入口、HTML/TXT 禁用缓存或部署后主动刷新缓存。
