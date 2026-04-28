module.exports = {
  apps: [
    {
      name: 'zolara',
      script: './scripts/start-zolara.sh',
      interpreter: 'none',
      cwd: '/home/drg/projects/zolara',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: 5000,
      restart_delay: 2000,
    },
    {
      name: 'zolara-lifecycle-worker',
      script: './scripts/run-lifecycle-worker.sh',
      interpreter: 'none',
      cwd: '/home/drg/projects/zolara',
      cron_restart: '* * * * *',
      autorestart: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
