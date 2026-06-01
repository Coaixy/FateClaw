# apps/web 安全修复报告

修复日期：2026-05-31  
范围：用户指定修复项 1、3、6、7、9。  
说明：原扫描报告 `docs/apps-web-security-scan-2026-05-30.md` 已删除，本文记录本次实际修复和验证结果。

## 修复摘要

已完成：

1. 修复 Web 直接依赖与同部署依赖漏洞。
2. 将 admin 登录页“记住此设备”默认值改为关闭，默认使用 `sessionStorage`。
3. 将 admin 失败鉴权限流从 `/api/admin/verify` 扩展到所有 `/api/admin/*` 路由。
4. 对 skills API 中的动态 path segment 统一 `encodeURIComponent`。
5. 重新运行依赖审计，当前 `pnpm audit --prod --filter fateclaw-web --json` 结果为 0 个漏洞。

未处理项：

- 原报告中的 2、4、5、8 本次按用户要求未修复。

## 1. 依赖漏洞修复

改动：

- `apps/web/package.json`：`next` 从 `^16.2.4` 升级到 `^16.2.6`。
- `apps/agent-runtime/package.json`：`@anthropic-ai/sdk` 从 `^0.81.0` 升级到 `^0.91.1`。
- `pnpm-workspace.yaml`：
  - `fast-jwt` override 升到 `>=6.2.4`。
  - 新增 `fast-uri: >=3.1.2` override。
  - 新增 `postcss: >=8.5.10` override。
  - `brace-expansion@^5.0.0` override 升到 `5.0.6`。
- `pnpm-lock.yaml` 已通过 `pnpm install --lockfile-only` 刷新。

锁文件确认：

- `next@16.2.6`
- `postcss@8.5.15`
- `fast-jwt@6.2.4`
- `fast-uri@3.1.2`
- `brace-expansion@5.0.6`
- `@anthropic-ai/sdk@0.91.1`

## 3. admin_key 默认持久化修复

改动：

- `apps/web/app/admin/page.tsx`：`remember` 默认值从 `true` 改为 `false`。

影响：

- 管理员不主动勾选“记住此设备”时，`setAdminKey(key, remember)` 会把 admin key 写入 `sessionStorage`，关闭 tab 后清除。
- 保留显式勾选持久化能力，避免破坏现有使用习惯。

## 6. admin 鉴权限流修复

改动：

- `apps/api/src/interfaces/http/admin-routes.ts`：
  - 所有 admin 请求都会先执行 `rateLimitCheck(rateKey)`。
  - 任意 `/api/admin/*` 端点上 `X-Admin-Key` 错误都会执行 `rateLimitRecordFail(rateKey)`。
  - 成功鉴权会执行 `rateLimitClear(rateKey)`。
  - 日志标识从 `admin verify rate limited` 改为 `admin auth rate limited`。

新增测试：

- `apps/api/src/interfaces/http/admin-routes.test.ts`
  - 覆盖非 `/verify` 端点错误 admin key 会记录失败。
  - 覆盖非 `/verify` 端点在限流状态下返回 429 和 `Retry-After`。

## 7. 动态 API path 编码修复

改动：

- `apps/web/features/skills/api.ts` 新增 `pathSegment()`，统一包装 `encodeURIComponent`。
- 已编码的动态 path segment 包括：
  - 用户 skill id
  - skill 分享 token
  - skill subscription id
  - bundle id
  - bundle 分享 token
  - bundle subscription id

新增测试：

- `apps/web/features/skills/api.test.ts`
  - 覆盖用户 skill id 中包含 `/../?` 时会被编码。
  - 覆盖 skill 分享 token 中包含 `/ ?` 时会被编码。
  - 覆盖 bundle 分享 token 中包含 `/ ?` 时会被编码。

## 9. 同部署依赖风险修复

改动同第 1 项，额外覆盖 API/agent 相关漏洞依赖：

- `fast-jwt@6.2.4`
- `fast-uri@3.1.2`
- `brace-expansion@5.0.6`
- `@anthropic-ai/sdk@0.91.1`

验证：

- `pnpm audit --prod --filter fateclaw-web --json` 返回空 advisory。

## 验证结果

已通过：

```text
node_modules/.bin/vitest run apps/web/features/skills/api.test.ts apps/api/src/interfaces/http/admin-routes.test.ts
Test Files  2 passed (2)
Tests       6 passed (6)
```

已通过：

```text
apps/api/node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.json
apps/web/node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json
node_modules/.bin/tsc --noEmit -p apps/agent-runtime/tsconfig.json
```

已通过：

```json
{
  "advisories": {},
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 0,
      "critical": 0
    }
  }
}
```

## 注意事项

- `pnpm exec ...` 在当前环境会触发 pnpm 依赖状态检查，并因非 TTY 中止；验证时改用已存在的本地 binary。
- `pnpm install --lockfile-only` 在 sandbox 下出现 registry metadata `EPERM/fetch failed` 警告，但最终成功刷新 lockfile。
- `pnpm audit` 首次因 sandbox 网络失败，已按流程使用联网权限重跑并通过。
