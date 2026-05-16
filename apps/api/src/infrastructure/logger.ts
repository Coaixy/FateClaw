import pino from 'pino';

// pino-pretty 同步格式化 + 颜色码会拖慢生产日志并污染聚合平台。
// 仅在非 production 或 LOG_PRETTY=1 时启用。
const usePretty =
  process.env.LOG_PRETTY === '1' ||
  (process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY !== '0');

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(usePretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
