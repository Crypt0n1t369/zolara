#!/bin/bash
# Reads the current tunnel URL and re-registers webhooks for all active project bots.
# Called by Zolara on startup to ensure webhooks are fresh.

TUNNEL_URL_FILE="/tmp/tunnel_url.txt"
ZOLARA_DIR="/home/drg/projects/zolara"
ENV_FILE="$ZOLARA_DIR/.env"

if [ ! -f "$TUNNEL_URL_FILE" ]; then
  echo "No tunnel URL file found at $TUNNEL_URL_FILE"
  exit 1
fi

TUNNEL_URL=$(cat "$TUNNEL_URL_FILE")
if [ -z "$TUNNEL_URL" ]; then
  echo "Tunnel URL is empty"
  exit 1
fi

echo "Updating WEBHOOK_BASE_URL to $TUNNEL_URL"

# Update .env
sed -i "s|WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" "$ENV_FILE"

# Re-run rehook script
cd "$ZOLARA_DIR" && npx tsx -e "
import { decrypt } from './src/util/crypto.ts';
import { db } from './src/data/db.ts';
import { projects } from './src/data/schema/projects.ts';
import { eq } from 'drizzle-orm';
import { setManagedBotWebhook } from './src/project/managed-bots/lifecycle.ts';
import { createHash } from 'crypto';

const BASE = '$TUNNEL_URL';

async function main() {
  const rows = await db.select({
    id: projects.id,
    name: projects.name,
    botUsername: projects.botUsername,
    botTokenEncrypted: projects.botTokenEncrypted,
    webhookSecret: projects.webhookSecret,
  }).from(projects).where(eq(projects.status, 'active'));
  
  let count = 0;
  for (const row of rows) {
    if (!row.botTokenEncrypted || !row.webhookSecret) continue;
    try {
      const token = decrypt(row.botTokenEncrypted);
      const hash = createHash('sha256').update(token).digest('hex');
      const url = \`\${BASE}/webhook/projectbot/\${hash}\`;
      await setManagedBotWebhook(token, url, row.webhookSecret);
      console.log(\`✅ @\${row.botUsername}: \${url}\`);
      count++;
    } catch(e: any) {
      console.error(\`❌ \${row.name}: \${e.message}\`);
    }
  }
  console.log(\`\nRegistered \${count} webhooks\`);
  process.exit(0);
}
main();
"
