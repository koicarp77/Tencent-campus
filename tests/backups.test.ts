import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openDb, type Db } from "../apps/api/src/database";
import { createApp } from "../apps/api/src/app";
import { writeDraft, readDraft, clearDraft } from "../apps/api/src/drafts";
let db: Db, server: Server, base: string, cookie: string, userId: string;
const mark = (content = "") => ({
  id: randomUUID(),
  x: 0.25,
  y: 0.6,
  content,
  sortOrder: 0,
});
const payload = (annotations: any[]) => ({
  expectedVersion: 0,
  baseRevision: 0,
  baseAnnotations: [],
  annotations,
  selectedId: annotations[0]?.id || null,
});
async function send(path: string, method = "GET", data?: any, auth = cookie) {
  return fetch(base + path, {
    method,
    headers: {
      ...(auth ? { Cookie: auth } : {}),
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
async function register(name: string) {
  const r = await send("/api/auth/register", "POST", { name }, "");
  return {
    cookie: r.headers.get("set-cookie")!.split(";")[0],
    user: (await r.json()).user,
  };
}
function image(
  id = "image",
  owner = userId,
  group = "default-group",
  connection = db,
) {
  connection
    .prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)")
    .run(
      id,
      id,
      "image/png",
      Buffer.from("draft-test"),
      900,
      1200,
      owner,
      "initial",
      "initial",
    );
  connection.prepare("INSERT INTO image_groups VALUES(?,?)").run(id, group);
}
beforeEach(async () => {
  db = openDb(":memory:");
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const account = await register("甲");
  cookie = account.cookie;
  userId = account.user.id;
  await send("/api/groups/default-group/join", "POST");
  image();
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("SQLite私人草稿备份", () => {
  it("允许空说明、换行与超出正式说明上限的草稿，不修改正式revision或批注", async () => {
    const id = randomUUID(),
      a = mark("第一行\n第二行  "),
      b = mark("");
    const input = payload([a, b]);
    const r = await send(`/api/images/image/drafts/${id}`, "PUT", input);
    expect(r.status).toBe(200);
    const saved = await r.json();
    expect(saved.annotations[0].content).toBe(a.content);
    expect(saved.annotations[1].content).toBe("");
    expect(saved.version).toBe(1);
    const list = await send("/api/images/image/drafts").then((r) => r.json());
    expect(list).toHaveLength(1);
    const review = await send("/api/images/image/review").then((r) => r.json());
    expect(review.image.revision).toBe(0);
    expect(review.annotations).toEqual([]);
  });
  it("同组不同账号也不能读取、覆盖或清除别人的草稿", async () => {
    const id = randomUUID();
    await send(
      `/api/images/image/drafts/${id}`,
      "PUT",
      payload([mark("私人说明")]),
    );
    const b = await register("乙");
    const changed = await fetch(base + "/api/images/image/drafts", {
      headers: { Cookie: cookie, "X-Draft-Owner": b.user.id },
    });
    expect(changed.status).toBe(412);
    await send("/api/groups/default-group/join", "POST", undefined, b.cookie);
    expect(
      await send("/api/images/image/drafts", "GET", undefined, b.cookie).then(
        (r) => r.json(),
      ),
    ).toEqual([]);
    expect(
      (await send(`/api/images/image/drafts/${id}`, "GET", undefined, b.cookie))
        .status,
    ).toBe(404);
    expect(
      (
        await send(
          `/api/images/image/drafts/${id}`,
          "DELETE",
          { expectedVersion: 1 },
          b.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          `/api/images/image/drafts/${id}`,
          "PUT",
          payload([mark("不能覆盖")]),
          b.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (await send("/api/images/image/drafts", "GET", undefined, "")).status,
    ).toBe(401);
  });
  it("独立窗口分支都保留；旧版本和清除后的迟到写入不能覆盖或复活", async () => {
    const id = randomUUID(),
      second = randomUUID(),
      a = mark("旧文案");
    await send(`/api/images/image/drafts/${id}`, "PUT", payload([a]));
    await send(
      `/api/images/image/drafts/${second}`,
      "PUT",
      payload([mark("另一窗口")]),
    );
    const newer = {
      ...payload([{ ...a, content: "新文案" }]),
      expectedVersion: 1,
    };
    expect(
      (await send(`/api/images/image/drafts/${id}`, "PUT", newer)).status,
    ).toBe(200);
    expect(
      (await send(`/api/images/image/drafts/${id}`, "PUT", payload([a])))
        .status,
    ).toBe(409);
    expect(
      (
        await send(`/api/images/image/drafts/${id}`, "DELETE", {
          expectedVersion: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send(`/api/images/image/drafts/${id}`, "DELETE", {
          expectedVersion: 2,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(`/api/images/image/drafts/${id}`, "PUT", {
          ...newer,
          expectedVersion: 2,
        })
      ).status,
    ).toBe(409);
    const neverWritten = randomUUID();
    await send(`/api/images/image/drafts/${neverWritten}`, "DELETE", {
      expectedVersion: 0,
    });
    expect(
      (
        await send(
          `/api/images/image/drafts/${neverWritten}`,
          "PUT",
          payload([a]),
        )
      ).status,
    ).toBe(409);
    const rows = await send("/api/images/image/drafts").then((r) => r.json());
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(second);
  });
  it("校验数量、坐标、ID、长度和版本，拒绝无效数据", async () => {
    const a = mark();
    for (const input of [
      payload([{ ...a, x: 2 }]),
      payload([a, a]),
      payload([mark("字".repeat(5001))]),
      payload(Array.from({ length: 101 }, () => mark())),
      { ...payload([a]), expectedVersion: -1 },
      { ...payload([a]), baseRevision: "0" },
    ])
      expect(
        (await send(`/api/images/image/drafts/${randomUUID()}`, "PUT", input))
          .status,
      ).toBe(400);
    expect(
      await send("/api/images/image/drafts").then((r) => r.json()),
    ).toEqual([]);
  });
  it("草稿独立2MiB请求限制，可备份100条各5000中文字符的未完成说明", async () => {
    const data = payload(
      Array.from({ length: 100 }, () => mark("中".repeat(5000))),
    );
    const r = await send(
      `/api/images/image/drafts/${randomUUID()}`,
      "PUT",
      data,
    );
    expect(r.status).toBe(200);
    expect((await r.json()).annotations).toHaveLength(100);
  });
  it("删除图片或群组会清理关联草稿，非成员不能访问", async () => {
    const group = await send("/api/groups", "POST", {
      name: "草稿清理组",
    }).then((r) => r.json());
    image("group-image", userId, group.id);
    await send(
      `/api/images/image/drafts/${randomUUID()}`,
      "PUT",
      payload([mark("保留")]),
    );
    await send(
      `/api/images/group-image/drafts/${randomUUID()}`,
      "PUT",
      payload([mark("清理")]),
    );
    const outsider = await register("非组员");
    expect(
      (
        await send(
          "/api/images/group-image/drafts",
          "GET",
          undefined,
          outsider.cookie,
        )
      ).status,
    ).toBe(403);
    expect((await send(`/api/groups/${group.id}`, "DELETE")).status).toBe(200);
    expect(
      (db.prepare("SELECT count(*) AS n FROM review_drafts").get() as any).n,
    ).toBe(1);
    expect(
      (await send("/api/images/image", "DELETE", { baseRevision: 0 })).status,
    ).toBe(200);
    expect(
      (db.prepare("SELECT count(*) AS n FROM review_drafts").get() as any).n,
    ).toBe(0);
  });
  it("真实文件数据库关闭重开仍恢复草稿与清除版本", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-backup-")),
      file = join(dir, "backup.sqlite");
    let disk = openDb(file);
    const id = randomUUID();
    try {
      disk.prepare("INSERT INTO operators VALUES(?,?)").run("writer", "作者");
      disk
        .prepare(
          "INSERT INTO group_members VALUES('default-group','writer','initial')",
        )
        .run();
      image("disk", "writer", "default-group", disk);
      writeDraft(disk, "disk", "writer", id, payload([mark("重启后仍在")]));
      disk.close();
      disk = openDb(file);
      expect(readDraft(disk, "disk", "writer", id).annotations[0].content).toBe(
        "重启后仍在",
      );
      clearDraft(disk, "disk", "writer", id, 1);
      disk.close();
      disk = openDb(file);
      expect(() =>
        writeDraft(disk, "disk", "writer", id, {
          ...payload([mark("迟到")]),
          expectedVersion: 1,
        }),
      ).toThrow("版本");
    } finally {
      disk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
