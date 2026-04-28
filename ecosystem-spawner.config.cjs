/**
 * PM2 ecosystem config for Zolara Spawner Agent
 * 
 * Spawner runs as a daemon that checks the queue file every 30s.
 * Zero LLM cost when idle — just a file read.
 * Spawns are triggered by queue entries, processed within 30s.
 * 
 * Start: pm2 start ecosystem-spawner.config.cjs
 * Logs:  pm2 logs zolara-spawner
 * Stop:  pm2 stop zolara-spawner
 */

module.exports = {
  apps: [
    {
      name: 'zolara-spawner',
      script: '/home/drg/projects/zolara/scripts/spawner-server.ts',
      args: 'daemon',
      interpreter: '/home/drg/projects/zolara/node_modules/.bin/tsx',
      cwd: '/home/drg/projects/zolara',
      autorestart: true,
      max_restarts: 20,
      min_uptime: 5000,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Africa/Cairo',
      },
      // Exponential backoff on failures
      exp_backoff_restart_delay: 1000,
    },
  ],
};
