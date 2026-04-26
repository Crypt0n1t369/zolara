module.exports = {
  apps: [
    {
      name: 'cloudflared',
      script: 'cloudflared',
      args: 'tunnel --url http://localhost:3000',
      cwd: '/tmp',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      min_uptime: 5000,
      restart_delay: 3000,
      env: {
        CLOUDFLARED_LOG: '/tmp/cloudflared.log',
      },
    },
  ],
};
