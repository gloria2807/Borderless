import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { env } from "../config/env";

export type Database = LibSQLDatabase<typeof schema>;

type Holder = { client: Client; db: Database; url: string; pinned?: boolean };
const globalForDb = globalThis as unknown as { __borderlessDb?: Holder };

function ensureDirectory(url: string) {
  if (!url.startsWith("file:")) return;
  const file = url.slice("file:".length);
  if (file === ":memory:" || file.startsWith(":")) return;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

export function createDatabase(url: string): Holder {
  ensureDirectory(url);
  const client = createClient({ url });
  return { client, db: drizzle(client, { schema }), url };
}

/** Process-wide database (survives Next.js dev hot reloads). */
export function db(): Database {
  const current = globalForDb.__borderlessDb;
  if (current?.pinned) return current.db;
  const url = env().DATABASE_URL;
  if (!globalForDb.__borderlessDb || globalForDb.__borderlessDb.url !== url) {
    globalForDb.__borderlessDb = createDatabase(url);
    // WAL + FK enforcement. Fire-and-forget is fine: libsql serialises statements on one connection.
    void globalForDb.__borderlessDb.client.execute("PRAGMA foreign_keys = ON");
    if (url.startsWith("file:") && !url.includes(":memory:")) {
      void globalForDb.__borderlessDb.client.execute("PRAGMA journal_mode = WAL");
    }
  }
  return globalForDb.__borderlessDb.db;
}

export function rawClient(): Client {
  db();
  return globalForDb.__borderlessDb!.client;
}

/** Tests: point the process at a different database. */
export function setDatabaseForTesting(holder: Holder): void {
  globalForDb.__borderlessDb = { ...holder, pinned: true };
}

export { schema };
