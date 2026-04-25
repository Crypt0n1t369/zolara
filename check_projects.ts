import { db } from './src/data/db';
import { projects, admins } from './src/data/schema/projects';
import { eq, desc } from 'drizzle-orm';
const rows = await db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects).innerJoin(admins, eq(admins.id, projects.adminId)).where(eq(admins.telegramId, 551447474)).orderBy(desc(projects.createdAt));
console.log('Kristaps projects:', JSON.stringify(rows, null, 2));
