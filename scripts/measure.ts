import { openDb } from "../apps/api/src/database.js";
import { performance } from "node:perf_hooks";
const db = openDb(":memory:");
db.prepare("INSERT INTO operators VALUES(?,?)").run("measure", "测量");
const buffer = Buffer.alloc(10 * 1024 * 1024, 42);
const t = new Date().toISOString();
const samples: number[] = [];
for (let i = 0; i < 8; i++) {
  const start = performance.now();
  db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
    `measure-${i}`,
    "10MiB BLOB",
    "image/png",
    buffer,
    1,
    1,
    "measure",
    t,
    t,
  );
  samples.push(performance.now() - start);
}
console.log(
  JSON.stringify(
    {
      description:
        "10MiB BLOB synchronous insert, in-memory SQLite, 8 samples; excludes image decode and disk IO",
      milliseconds: samples,
      maximum: Math.max(...samples),
    },
    null,
    2,
  ),
);
db.close();
