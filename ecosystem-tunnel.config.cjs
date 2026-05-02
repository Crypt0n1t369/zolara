const tunnelName = process.env.ZOLARA_TUNNEL_NAME || 'zolara-prod';

module.exports = {
  apps: [
    {
      name: 'cloudflared',
      script: 'cloudflared',
      // Production/tester tunnel must be named so WEBHOOK_BASE_URL stays stable.
      // One-time setup:
      //   cloudflared tunnel create zolara-prod
      //   cloudflared tunnel route dns zolara-prod <stable-hostname>
      //   create ~/.cloudflared/config.yml with ingress to http://localhost:3000
      args: `tunnel run ${tunnelName}`,
      cwd: '/tmp',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      min_uptime: 5000,
      restart_delay: 3000,
      env: {
        ZOLARA_TUNNEL_NAME: tunnelName,
      },
    },
  ],
};
