import { openDb } from "../apps/api/src/database.js";
import { seed } from "../apps/api/src/seed.js";
const db = openDb();
try {
  await seed(db);
  console.log("数据库迁移、演示数据初始化完成（保留现有批注）");
} finally {
  db.close();
}
