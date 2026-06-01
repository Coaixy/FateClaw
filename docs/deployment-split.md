# 前后端分离部署

FateClaw 生产环境推荐使用同域名路径分离：

```text
https://example.com/        -> Web 静态站点
https://example.com/api/*   -> Fastify API
```

这样浏览器仍然同源访问 `/api/*`，不需要额外配置跨域和 Cookie 域名。

## 打包

```bash
npm run pack
```

默认会生成两个包：

```text
fateclaw-api-v<version>-runtime.tar.gz
fateclaw-web-v<version>-static.tar.gz
```

也可以单独打包：

```bash
bash scripts/pack.sh api-runtime
bash scripts/pack.sh api-source
bash scripts/pack.sh api
bash scripts/pack.sh web
```

## API 部署

生产环境推荐使用 API runtime 包。它已经包含 `apps/api/dist` 和
`packages/agent-runner/dist`，服务器不需要再执行 TypeScript 构建。
包内 `.npmrc` 会设置 `package-lock=false`，避免 1Panel 旧项目目录里残留的
`package-lock.json` 影响本次安装。

```bash
mkdir -p fateclaw
tar xzf fateclaw-api-v<version>-runtime.tar.gz --strip-components=1 -C fateclaw
cd fateclaw
npm install --omit=dev -f
npm run start
```

在 1Panel 的 Node.js 运行环境中，启动命令可填写：

```bash
npm install --omit=dev -f && npm run start
```

如需在服务器上重新构建源码包，可使用 `bash scripts/pack.sh api` 生成
`fateclaw-api-v<version>-source.tar.gz`，部署时仍执行
`npm install -f && npm run build && npm run start`。

## Web 部署

```bash
mkdir -p /var/www/fateclaw-web
tar xzf fateclaw-web-v<version>-static.tar.gz -C /var/www/fateclaw-web
```

Web 包内就是静态站点根目录内容，包含 `index.html`、`_next/static/*` 和各页面目录。

## Nginx 示例

```nginx
server {
  listen 80;
  server_name example.com;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    root /var/www/fateclaw-web;
    try_files $uri $uri/ /index.html;
  }
}
```

如果部署了 HTTPS，把 `listen` 和证书配置加到同一个 server 内即可。
