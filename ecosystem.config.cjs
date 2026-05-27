module.exports = {
  apps: [
    {
      name: 'fateclaw',
      script: 'apps/api/dist/app/index.js',
      cwd: __dirname,
      env_file: '.env.production',
      node_args: '--enable-source-maps',
      // 自动重启
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // 日志
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      // 内存超限自动重启
      max_memory_restart: '1G',
    },
  ],
};
