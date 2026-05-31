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
fateclaw-api-v<version>-source.tar.gz
fateclaw-web-v<version>-static.tar.gz
```

也可以单独打包：

```bash
bash scripts/pack.sh api
bash scripts/pack.sh web
```

## API 部署

```bash
tar xzf fateclaw-api-v<version>-source.tar.gz
cd fateclaw
npm install -f
npm run build
npm run start
```

`npm run build` 只构建 API 和 agent-runner，API 进程不再依赖 Web 构建产物。

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
