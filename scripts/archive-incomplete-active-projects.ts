#!/usr/bin/env npx tsx
/**
 * Archive legacy active project rows that cannot receive Telegram updates.
 *
 * Dry-run by default. Set CONFIRM_ARCHIVE=1 to update rows.
 * Prints only redacted IDs and non-secret project metadata.
 */

import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../src/data/db';
import { projects } from '../src/data/schema/projects';

function redactedId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      botUsername: projects.botUsername,
      botTokenEncrypted: projects.botTokenEncrypted,
      webhookSecret: projects.webhookSecret,
    })
    .from(projects)
    .where(and(
      eq(projects.status, 'active'),
      or(
        isNull(projects.botUsername),
        isNull(projects.botTokenEncrypted),
        isNull(projects.webhookSecret)
      )
    ));

  if (rows.length === 0) {
    console.log('No incomplete active project rows found.');
    return;
  }

  const confirm = process.env.CONFIRM_ARCHIVE === '1';
  console.log(`${confirm ? 'Archiving' : 'Dry run: would archive'} ${rows.length} incomplete active project row(s):`);
  for (const row of rows) {
    const missing = [
      row.botUsername ? null : 'botUsername',
      row.botTokenEncrypted ? null : 'botTokenEncrypted',
      row.webhookSecret ? null : 'webhookSecret',
    ].filter(Boolean).join(', ');
    console.log(`- ${redactedId(row.id)} ${row.name} missing: ${missing}`);
  }

  if (!confirm) {
    console.log('\nSet CONFIRM_ARCHIVE=1 to archive these rows.');
    return;
  }

  for (const row of rows) {
    await db.update(projects).set({ status: 'archived', updatedAt: new Date() }).where(eq(projects.id, row.id));
  }
  console.log(`Archived ${rows.length} incomplete active project row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
