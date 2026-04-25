import { db } from './src/data/db';
import { projects, admins } from './src/data/schema/projects';
import { eq, desc } from 'drizzle-orm';

async function main() {
  const adminRows = await db.select().from(admins).where(eq(admins.telegramId, BigInt(551447474)));
  console.log('Admins for 551447474:', JSON.stringify(adminRows, null, 2));
  
  if (adminRows.length === 0) {
    console.log('NO ADMIN RECORD for Kristaps!');
    const allAdmins = await db.select().from(admins).limit(10);
    console.log('All admins (limit 10):', JSON.stringify(allAdmins, null, 2));
  } else {
    const adminId = adminRows[0].id;
    const projectRows = await db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects).where(eq(projects.adminId, adminId)).orderBy(desc(projects.createdAt));
    console.log('Projects for adminId', adminId, ':', JSON.stringify(projectRows, null, 2));
  }
}
main().catch(console.error);
