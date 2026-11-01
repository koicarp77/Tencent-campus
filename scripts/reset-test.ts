import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { seed } from "../apps/api/src/seed.js";
import { openDb } from "../apps/api/src/database.js";
const directory = process.env.E2E_DIR,
  file = process.env.DB_FILE;
if (
  !directory ||
  !file ||
  !basename(directory).startsWith("review-desk-e2e-") ||
  !realpathSync(directory).startsWith(realpathSync(tmpdir()) + "/") ||
  resolve(dirname(file)) !== resolve(directory) ||
  readFileSync(resolve(directory, ".e2e-marker"), "utf8") !== "review-desk"
)
  throw new Error("拒绝重置：仅接受本次测试临时数据库");
const db = openDb(file);
try {
  db.transaction(() => {
    db.prepare("DELETE FROM review_submissions").run();
    db.prepare("DELETE FROM review_versions").run();
    db.prepare("DELETE FROM review_drafts").run();
    db.prepare("DELETE FROM deleted_seed_images").run();
    db.prepare("DELETE FROM annotations").run();
    db.prepare(
      "DELETE FROM images WHERE id NOT IN ('demo-poster','demo-detail')",
    ).run();
    db.prepare("UPDATE images SET revision=0,updated_at=created_at").run();
    db.prepare("DELETE FROM sessions").run();
    db.prepare(
      "DELETE FROM group_members WHERE group_id!='default-group' OR operator_id NOT IN ('operator-1','operator-2')",
    ).run();
    db.prepare("DELETE FROM groups WHERE id!='default-group'").run();
    db.prepare(
      "DELETE FROM accounts WHERE operator_id NOT IN ('operator-1','operator-2')",
    ).run();
    db.prepare(
      "DELETE FROM operators WHERE id NOT IN ('operator-1','operator-2')",
    ).run();
  })();
  await seed(db);
} finally {
  db.close();
}
