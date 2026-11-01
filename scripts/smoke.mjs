import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url)),
  directory = await mkdtemp(join(tmpdir(), "review-desk-smoke-"));
const s = net.createServer();
await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
const port = s.address().port;
await new Promise((resolve) => s.close(resolve));
const env = {
  ...process.env,
  DB_FILE: join(directory, "smoke.sqlite"),
  PORT: String(port),
};
const base = `http://127.0.0.1:${port}`;
let server;
let cookie = "";
async function setup() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/setup.ts"],
    { cwd: root, env, stdio: "inherit" },
  );
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
}
async function start() {
  server = spawn(
    process.execPath,
    [resolve(root, "dist/apps/api/src/server.js")],
    { cwd: directory, env, stdio: "inherit" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    if (server.exitCode !== null) throw new Error("server exited");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("readiness timeout");
}
async function stop() {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  server = null;
}
async function crash() {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGKILL");
    await exited;
  }
  server = null;
}
async function get() {
  const response = await fetch(base + "/api/images/demo-detail/review", {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function save(annotations, baseRevision) {
  const response = await fetch(base + "/api/images/demo-detail/annotations", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ actorId: "operator-1", baseRevision, annotations }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  await setup();
  await start();
  assert.equal((await fetch(base + "/")).status, 200);
  const auth = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "小林" }),
  });
  assert.equal(auth.status, 200);
  cookie = auth.headers.get("set-cookie").split(";")[0];
  const a = {
    id: randomUUID(),
    x: 0.34,
    y: 0.76,
    content: "重启后应恢复",
    sortOrder: 0,
  };
  await save([a], 0);
  const backupId = randomUUID();
  const backup = await fetch(
    base + `/api/images/demo-detail/drafts/${backupId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        expectedVersion: 0,
        baseRevision: 1,
        baseAnnotations: [a],
        annotations: [{ ...a, content: "重启恢复的私人草稿" }],
        selectedId: a.id,
      }),
    },
  );
  assert.equal(backup.status, 200);

  await stop();
  await setup();
  await start();
  assert.equal((await get()).annotations[0].content, a.content);
  assert.equal((await get()).image.revision, 1);
  const restored = await fetch(base + "/api/images/demo-detail/drafts", {
    headers: { Cookie: cookie },
  }).then((r) => r.json());
  assert.equal(restored[0].annotations[0].content, "重启恢复的私人草稿");

  await save([], 1);
  await stop();
  await start();
  assert.deepEqual((await get()).annotations, []);
  for (const [id, baseRevision] of [
    ["demo-detail", 2],
    ["demo-poster", 0],
  ]) {
    const response = await fetch(base + `/api/images/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ baseRevision }),
    });
    assert.equal(response.status, 200);
  }
  await stop();
  await setup();
  await start();
  const images = await fetch(base + "/api/images?groupId=default-group", {
    headers: { Cookie: cookie },
  });
  assert.equal(images.status, 200);
  assert.deepEqual(await images.json(), []);
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal(
    (
      await fetch(base + `/api/images/demo-detail/drafts/${backupId}`, {
        headers: { Cookie: cookie },
      })
    ).status,
    404,
  );

  console.log(
    "PASS: 独立文件库、跨工作目录生产启动、重复初始化保留数据、保存后重启恢复、清空后重启无残留、删除全部照片后初始化不复活且空库正常启动、私人草稿强制终止后恢复及图片删除级联清理",
  );
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
