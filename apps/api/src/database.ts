import Database from "better-sqlite3";
import { migrateCollaboration } from "./collaboration.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("../../../", import.meta.url));
// Compiled modules live three levels deeper than source modules.
export const projectRoot = root.endsWith("/dist/") ? resolve(root, "..") : root;
export function openDb(
  path = process.env.DB_FILE || resolve(projectRoot, "data/review.sqlite"),
) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS operators(id TEXT PRIMARY KEY,name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,title TEXT NOT NULL,mime_type TEXT NOT NULL,image_blob BLOB NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL REFERENCES operators(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY,image_id TEXT NOT NULL REFERENCES images(id),x REAL NOT NULL CHECK(x>=0 AND x<=1),y REAL NOT NULL CHECK(y>=0 AND y<=1),content TEXT NOT NULL CHECK(length(content)>0),sort_order INTEGER NOT NULL,created_by TEXT NOT NULL REFERENCES operators(id),updated_by TEXT NOT NULL REFERENCES operators(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS annotations_image ON annotations(image_id,sort_order);
  `);
  migrateCollaboration(db);
  return db;
}
export type Db = ReturnType<typeof openDb>;
