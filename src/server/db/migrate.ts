import { migrate } from "drizzle-orm/libsql/migrator";
import path from "node:path";
import type { Database } from "./client";

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}
