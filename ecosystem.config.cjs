module.exports = {
  apps: [
    {
      name: 'fateclaw',
      script: 'apps/api/dist/app/index.js',
      cwd: __dirname,
      // 打包与部署链路（scripts/pack.sh、docs/deployment-split.md）携带的是 .env，
      // 此前误指向不存在的 .env.production 导致 PM2 启动时读不到任何环境变量。
      env_file: '.env',
      node_args: '--enable-source-maps',
      // 自动重启
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // 优雅停机窗口：API 内部 shutdown 会等所有 agent-runtime 子进程排空
      // （子进程 drain 30s + 强杀 35s + Redis/DB 关闭），PM2 默认 1.6s 就 SIGKILL
      // 会把整条优雅退出链掐断，必须放宽到覆盖内部停机链的上限。
      kill_timeout: 45000,
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
