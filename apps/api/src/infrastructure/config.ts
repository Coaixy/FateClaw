import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'aliyun.sms.access-key-id',
  'aliyun.sms.access-key-secret',
  'aliyun.sms.endpoint',
  'ALIYUN_SMS_ACCESS_KEY_ID',
  'ALIYUN_SMS_ACCESS_KEY_SECRET',
  'ALIYUN_SMS_ENDPOINT',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'MANAGER_KEY',
  'USER_MANAGER_KEY',
  'ALLOWED_ORIGINS',
  'PUBLIC_BASE_URL',
  'PUBLIC_API_BASE_URL',
  'PUBLIC_WEB_BASE_URL',
  'API_BASE_URL',
  'WEB_BASE_URL',
  'PAYMENT_CALLBACK_ALLOWED_HOSTS',
  'TRUST_PROXY',
  'ALERT_WEBHOOK_URL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

// 数据库 & Redis 连接地址
export const DATABASE_URL =
  process.env.DATABASE_URL || envConfig.DATABASE_URL || '';
export const REDIS_URL = process.env.REDIS_URL || envConfig.REDIS_URL || '';

// 短信配置优先使用 .env 文件，避免本地常驻进程残留的旧环境变量覆盖最新配置。
export const ALIYUN_SMS_ACCESS_KEY_ID =
  envConfig['aliyun.sms.access-key-id'] ||
  envConfig.ALIYUN_SMS_ACCESS_KEY_ID ||
  process.env.ALIYUN_SMS_ACCESS_KEY_ID ||
  '';
export const ALIYUN_SMS_ACCESS_KEY_SECRET =
  envConfig['aliyun.sms.access-key-secret'] ||
  envConfig.ALIYUN_SMS_ACCESS_KEY_SECRET ||
  process.env.ALIYUN_SMS_ACCESS_KEY_SECRET ||
  '';
export const ALIYUN_SMS_ENDPOINT =
  envConfig['aliyun.sms.endpoint'] ||
  envConfig.ALIYUN_SMS_ENDPOINT ||
  process.env.ALIYUN_SMS_ENDPOINT ||
  '';

// JWT 密钥——必须由 .env 或环境变量提供，且不得等于历史默认值
const RAW_JWT_SECRET = process.env.JWT_SECRET || envConfig.JWT_SECRET || '';
const FORBIDDEN_SECRETS = new Set([
  'fateclaw-dev-secret-change-me',
  'change-me',
  'secret',
  'changeme',
]);
// 测试环境下绕过强密钥校验，避免 vitest 必须配 .env 才能跑
const IS_TEST_ENV =
  process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

function assertStrongSecret(name: string, value: string, minLen = 32): void {
  if (IS_TEST_ENV) return;
  if (!value || FORBIDDEN_SECRETS.has(value) || value.length < minLen) {
    throw new Error(
      `${name} 未配置或过弱：必须设置长度 >=${minLen} 的强随机值。可用 \`openssl rand -hex 32\` 生成。`,
    );
  }
}

assertStrongSecret('JWT_SECRET', RAW_JWT_SECRET);
export const JWT_SECRET = RAW_JWT_SECRET || 'test-secret-not-for-production';

// 管理端密钥——管理后台认证；缺失时管理后台不可用，提供时必须强随机
const RAW_MANAGER_KEY = process.env.MANAGER_KEY || envConfig.MANAGER_KEY || '';
if (RAW_MANAGER_KEY) {
  assertStrongSecret('MANAGER_KEY', RAW_MANAGER_KEY);
}
export const MANAGER_KEY = RAW_MANAGER_KEY;

// 用户管理员密钥——仅开放用户和消息模块；缺失时不启用该受限后台身份
const RAW_USER_MANAGER_KEY =
  process.env.USER_MANAGER_KEY || envConfig.USER_MANAGER_KEY || '';
if (RAW_USER_MANAGER_KEY) {
  assertStrongSecret('USER_MANAGER_KEY', RAW_USER_MANAGER_KEY);
}
export const USER_MANAGER_KEY = RAW_USER_MANAGER_KEY;

function normalizePublicBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!URL.canParse(trimmed)) return '';
  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return `${url.protocol}//${url.host}`;
}

function normalizeAllowedOrigins(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(normalizePublicBaseUrl)
        .filter((origin) => origin.length > 0),
    ),
  );
}

function normalizeAllowedHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const candidate = URL.canParse(trimmed) ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return '';
  const url = new URL(candidate);
  return url.pathname === '/' && !url.search && !url.hash
    ? url.host.toLowerCase()
    : '';
}

function normalizeAllowedHosts(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(normalizeAllowedHost)
        .filter((host) => host.length > 0),
    ),
  );
}

// 公开访问地址用于生成第三方支付回调 URL。未配置时只允许可信 Host 兜底。
export const PUBLIC_BASE_URL = normalizePublicBaseUrl(
  process.env.PUBLIC_BASE_URL || envConfig.PUBLIC_BASE_URL || '',
);

// API 公开访问地址用于生成支付平台异步通知 notify_url；默认兼容旧 PUBLIC_BASE_URL。
export const PUBLIC_API_BASE_URL =
  normalizePublicBaseUrl(
    process.env.PUBLIC_API_BASE_URL ||
      envConfig.PUBLIC_API_BASE_URL ||
      process.env.API_BASE_URL ||
      envConfig.API_BASE_URL ||
      '',
  ) || PUBLIC_BASE_URL;

// www 公开访问地址用于生成用户支付完成后的 return_url；默认兼容旧 PUBLIC_BASE_URL。
export const PUBLIC_WEB_BASE_URL =
  normalizePublicBaseUrl(
    process.env.PUBLIC_WEB_BASE_URL ||
      envConfig.PUBLIC_WEB_BASE_URL ||
      process.env.WEB_BASE_URL ||
      envConfig.WEB_BASE_URL ||
      '',
  ) || PUBLIC_BASE_URL;

// 浏览器跨域来源白名单，API CORS 使用；这里只保留 origin，避免路径误配置影响匹配。
export const ALLOWED_ORIGINS = normalizeAllowedOrigins(
  process.env.ALLOWED_ORIGINS || envConfig.ALLOWED_ORIGINS || '',
);

// 支付回调 Host 兜底白名单，避免 Host/X-Forwarded-Host 污染下单回调地址。
export const PAYMENT_CALLBACK_ALLOWED_HOSTS = normalizeAllowedHosts(
  process.env.PAYMENT_CALLBACK_ALLOWED_HOSTS ||
    envConfig.PAYMENT_CALLBACK_ALLOWED_HOSTS ||
    '',
);

// 反向代理信任拓扑解析。Fastify 据此从 X-Forwarded-For 还原真实客户端 IP。
function parseTrustProxy(raw: string): boolean | string {
  const value = raw.trim();
  // 默认仅信任本机回环代理：外部客户端的连接源永远不是回环地址，无法伪造
  // X-Forwarded-For；同机 Nginx 反代的常见部署可直接生效，裸暴露公网时也安全。
  if (!value) return 'loopback';
  if (value === 'true') return true; // 信任全部代理：仅限已知可信内网，谨慎使用
  if (value === 'false' || /^0+$/.test(value)) return false;
  // Fastify removed hop-count trust; legacy values use the loopback default.
  if (/^\d+$/.test(value)) return 'loopback';
  return value; // 逗号分隔的 IP/CIDR 白名单，交给 Fastify 解析
}

// 反向代理信任配置。生产部署在 Nginx/ALB/CDN 后必须按真实拓扑设置，否则
// request.ip 取到代理 IP，导致所有按 IP 的限流/验证码绑定/登录爆破锁定坍缩成
// 全局单桶。切勿设为 'true'（会无条件信任可伪造的 X-Forwarded-For，限流反被绕过）。
export const TRUST_PROXY = parseTrustProxy(
  process.env.TRUST_PROXY || envConfig.TRUST_PROXY || '',
);

// 超过该时长仍未完成结算的预留请求会被自动释放占用，但保留账务记录，
// 便于晚到响应继续补结算。
export const BILLING_RESERVATION_STALE_MS = parseInt(
  process.env.BILLING_RESERVATION_STALE_MS || '2400000',
  10,
);

// 运维告警 webhook 地址（可选）。配置后关键运行时异常（inbox/outbox 堆积清理、
// 子进程异常退出、计费按 0 关账等）会 POST JSON 到该地址；未配置时降级为仅记日志。
export const ALERT_WEBHOOK_URL = (
  process.env.ALERT_WEBHOOK_URL ||
  envConfig.ALERT_WEBHOOK_URL ||
  ''
).trim();

// 低余额并发门槛（积分）。可消费积分低于此值的用户，同一时刻只能有 1 个 metered
// 官方模型请求在跑，防止多 session 并发把余额刷成大额欠费（白嫖）。
// 健康余额用户不受影响（不进入 per-user 并发门，沿用全局并发上限）。
export const LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS = parseFloat(
  process.env.LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS || '5',
);

// 单账户欠费深度上限（积分）。模型结算最多把可消费余额扣到 -MAX_OVERDRAFT_COINS，
// 超出部分平台兜底吸收（rawChargeCoins 仍记真实成本供审计）。配合入口 arrears 拦截 +
// 低余额并发门，把单账户最坏赊账损失锁死在此值，防止低余额用户用一个超长请求透支任意
// 金额后弃号薅羊毛。误配置（非有限值/负数）回退默认值，避免静默停止扣费。
const RAW_MAX_OVERDRAFT_COINS = parseFloat(
  process.env.MAX_OVERDRAFT_COINS || '50',
);
export const MAX_OVERDRAFT_COINS =
  Number.isFinite(RAW_MAX_OVERDRAFT_COINS) && RAW_MAX_OVERDRAFT_COINS >= 0
    ? RAW_MAX_OVERDRAFT_COINS
    : 50;

// 后台任务与 agent-runtime 使用的默认时区
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// conversation_log_payloads.trace_events 的保留天数。超过此天数的 trace_events 列
// 会被后台保留策略置 NULL（transcript 等业务数据保留不变）。trace 是纯调试数据，
// 7 天足够覆盖"昨天出了问题帮我查一下"的典型排障场景。
export const TRACE_RETENTION_DAYS = parseInt(
  process.env.TRACE_RETENTION_DAYS || '7',
  10,
);

// 对外会话（open_sessions）过期后再保留多少天才物理清理。会话本身有 30 天滑动 TTL
// （OPEN_SESSION_TTL_DAYS），过期后仍保留一段时间供「API 使用详情」面板对账；超过本保留期
// 才由后台保留任务整套物理删除（open_sessions + 兜底 chat_sessions + messages）。
// 实际数据留存 ≈ 末次活动 + 30(TTL) + 本值 天。
export const OPEN_SESSION_RETENTION_DAYS = parseInt(
  process.env.OPEN_SESSION_RETENTION_DAYS || '30',
  10,
);
