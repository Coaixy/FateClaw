import path from 'path';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
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
  'SKILL_API_BASE',
  'WITHDRAWAL_ENCRYPTION_KEY',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

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

// 积分体系：1 元人民币 = 100 积分
export const POINTS_PER_YUAN = 100;

// 提现身份证号/银行账户加密密钥（32 字节 hex = 64 字符）。
// 未配置时开发环境走 fallback（会在日志中警告），生产环境必须配置。
const RAW_WITHDRAWAL_KEY =
  process.env.WITHDRAWAL_ENCRYPTION_KEY ||
  envConfig.WITHDRAWAL_ENCRYPTION_KEY ||
  '';
export const WITHDRAWAL_ENCRYPTION_KEY = RAW_WITHDRAWAL_KEY;

// 超过该时长仍未完成结算的预留请求会被自动释放占用，但保留账务记录，
// 便于晚到响应继续补结算。
export const BILLING_RESERVATION_STALE_MS = parseInt(
  process.env.BILLING_RESERVATION_STALE_MS || '2400000',
  10,
);

// 平台从创作者订阅收入中抽成的百分比（0-100）。默认 30%，可由环境变量覆盖。
export const PLATFORM_CUT_PERCENT = Math.min(
  Math.max(parseInt(process.env.PLATFORM_CUT_PERCENT || '30', 10), 0),
  100,
);

const PROJECT_ROOT = process.cwd();
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// 定时任务使用的时区
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Skill API 基础地址
export const SKILL_API_BASE =
  process.env.SKILL_API_BASE ||
  envConfig.SKILL_API_BASE ||
  'https://skill.letfate.com/v1';

// conversation_logs.trace_events 的保留天数。超过此天数的 trace_events 列
// 会被定时任务置 NULL（transcript 等业务数据保留不变）。trace 是纯调试数据，
// 7 天足够覆盖"昨天出了问题帮我查一下"的典型排障场景。
export const TRACE_RETENTION_DAYS = parseInt(
  process.env.TRACE_RETENTION_DAYS || '7',
  10,
);
