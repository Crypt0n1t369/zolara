import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/data/schema/projects.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://zolara:zolara_dev_pass@localhost:5432/zolara_dev',
  },
});
