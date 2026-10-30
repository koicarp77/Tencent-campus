import { openDb, projectRoot } from "./database.js";
import { createApp } from "./app.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
if (
  import.meta.url.endsWith(".js") &&
  !existsSync(resolve(projectRoot, "dist/web/index.html"))
)
  throw new Error("缺少前端构建产物，请先运行 npm run build");
const db = openDb();
if (!(db.prepare("SELECT count(*) AS n FROM images").get() as any).n)
  throw new Error("数据库未初始化，请先运行 npm run db:setup");
const server = createApp(db).listen(
  Number(process.env.PORT || 3001),
  "127.0.0.1",
  () => console.log(`审图台 http://127.0.0.1:${process.env.PORT || 3001}`),
);
server.on("error", (e) => {
  console.error(e);
  db.close();
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
