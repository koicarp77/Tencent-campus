import { beforeEach, afterEach, it, expect, describe } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openDb, type Db } from "../apps/api/src/database";
import { createApp } from "../apps/api/src/app";
import { review, saveReview } from "../apps/api/src/service";
import type { Server } from "node:http";
let db: Db, server: Server, base: string;
beforeEach(async () => {
  db = openDb(":memory:");
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});
async function send(path: string, cookie = "", method = "GET", data?: any) {
  return fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
async function register(name: string) {
  const response = await send("/api/auth/register", "", "POST", { name });
  expect(response.status).toBe(201);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0],
    user: (await response.json()).user,
  };
}
async function create(cookie: string, name: string) {
  const r = await send("/api/groups", cookie, "POST", { name });
  expect(r.status).toBe(201);
  return r.json();
}
async function upload(cookie: string, groupId: string) {
  const png = await sharp({
    create: { width: 30, height: 40, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("image", new Blob([png]), "same-name.png");
  const r = await fetch(base + `/api/images?groupId=${groupId}`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  expect(r.status).toBe(201);
  return (await r.json()).image;
}
const mark = (content = "检查文字") => ({
  id: randomUUID(),
  x: 0.25,
  y: 0.6,
  content,
  sortOrder: 0,
});

describe("无密码账号与SQLite会话", () => {
  it("注册、登录、规范化唯一性、未知账号、登出与撤销会话", async () => {
    expect(
      (await send("/api/auth/session").then((r) => r.json())).user,
    ).toBeNull();
    expect((await send("/api/groups")).status).toBe(401);
    const a = await register(" Alice ");
    expect(a.user.name).toBe("Alice");
    expect(
      (await send("/api/auth/register", "", "POST", { name: "ａｌｉｃｅ" }))
        .status,
    ).toBe(409);
    const login = await send("/api/auth/login", "", "POST", { name: "ALICE" });
    expect(login.status).toBe(200);
    expect((await login.json()).user.id).toBe(a.user.id);
    expect(
      (await send("/api/auth/login", "", "POST", { name: "不存在" })).status,
    ).toBe(404);
    expect(
      (await send("/api/auth/session", a.cookie).then((r) => r.json())).user.id,
    ).toBe(a.user.id);
    expect((await send("/api/auth/logout", a.cookie, "POST")).status).toBe(200);
    expect((await send("/api/groups", a.cookie)).status).toBe(401);
    const hashes = db.prepare("SELECT token_hash FROM sessions").all() as any[];
    expect(hashes.every((row) => !a.cookie.includes(row.token_hash))).toBe(
      true,
    );
  });
  it("过期会话拒绝访问，账号名空白及超长拒绝且不留账号", async () => {
    const a = await register("甲");
    db.prepare("UPDATE sessions SET expires_at=0").run();
    expect((await send("/api/groups", a.cookie)).status).toBe(401);
    for (const name of ["", " ", "字".repeat(33), "a\nb"])
      expect(
        (await send("/api/auth/register", "", "POST", { name })).status,
      ).toBe(400);
    expect(
      (db.prepare("SELECT count(*) AS n FROM accounts").get() as any).n,
    ).toBe(1);
  });
});
describe("开放群组、隔离与操作归属", () => {
  it("任意账号创建、搜索、无需审批加入；重名与通配字符按字面处理", async () => {
    const a = await register("甲"),
      b = await register("乙");
    const group = await create(a.cookie, " 海报_审核% ");
    expect(group.memberCount).toBe(1);
    expect(
      (await send("/api/groups", b.cookie, "POST", { name: "海报_审核%" }))
        .status,
    ).toBe(409);
    expect(
      (
        await send(
          "/api/groups?search=" + encodeURIComponent("_"),
          b.cookie,
        ).then((r) => r.json())
      ).map((g: any) => g.id),
    ).toEqual([group.id]);
    const found = await send(
      "/api/groups?search=" + encodeURIComponent("海报"),
      b.cookie,
    ).then((r) => r.json());
    expect(found[0].joined).toBe(false);
    expect(
      (await send(`/api/images?groupId=${group.id}`, b.cookie)).status,
    ).toBe(403);
    for (let i = 0; i < 2; i++) {
      const join = await send(`/api/groups/${group.id}/join`, b.cookie, "POST");
      expect(join.status).toBe(200);
      expect((await join.json()).memberCount).toBe(2);
    }
    expect(
      (await send(`/api/images?groupId=${group.id}`, b.cookie)).status,
    ).toBe(200);
    expect(
      (await send("/api/groups/missing/join", b.cookie, "POST")).status,
    ).toBe(404);
    const separate = await create(b.cookie, "乙自己的组");
    expect(separate.joined).toBe(true);
  });
  it("非成员不能读图片或批注、保存或上传；加入后共同标注且不信任actorId", async () => {
    const a = await register("甲"),
      b = await register("乙");
    const group = await create(a.cookie, "共同审核");
    const image = await upload(a.cookie, group.id);
    for (const suffix of ["content", "review"])
      expect(
        (await send(`/api/images/${image.id}/${suffix}`, b.cookie)).status,
      ).toBe(403);
    expect(
      (
        await send(`/api/images/${image.id}/annotations`, b.cookie, "PUT", {
          actorId: a.user.id,
          baseRevision: 0,
          annotations: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (await send(`/api/images?groupId=${group.id}`, b.cookie, "POST")).status,
    ).toBe(403);
    expect((await send(`/api/images/${image.id}/content`)).status).toBe(401);
    const first = mark();
    const saved = await send(
      `/api/images/${image.id}/annotations`,
      a.cookie,
      "PUT",
      { actorId: b.user.id, baseRevision: 0, annotations: [first] },
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).annotations[0].createdBy).toBe(a.user.id);
    await send(`/api/groups/${group.id}/join`, b.cookie, "POST");
    const second = mark("乙新增");
    const updated = await send(
      `/api/images/${image.id}/annotations`,
      b.cookie,
      "PUT",
      {
        actorId: a.user.id,
        baseRevision: 1,
        annotations: [{ ...first, content: "乙修改" }, second],
      },
    );
    expect(updated.status).toBe(200);
    const result = await updated.json();
    expect(result.annotations[0].createdBy).toBe(a.user.id);
    expect(result.annotations[0].updatedBy).toBe(b.user.id);
    expect(result.annotations[1].createdBy).toBe(b.user.id);
    expect(
      (
        await send(`/api/images/${image.id}/annotations`, a.cookie, "PUT", {
          baseRevision: 1,
          annotations: [],
        })
      ).status,
    ).toBe(200);
    const other = await create(b.cookie, "另一个组");
    await upload(b.cookie, other.id);
    const list = await send(`/api/images?groupId=${group.id}`, b.cookie).then(
      (r) => r.json(),
    );
    expect(list.map((i: any) => i.id)).toEqual([image.id]);
  });
});

it("旧版文件库迁移后图片、批注、作者和revision不变，重复迁移不清空", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-migrate-")),
    file = join(dir, "legacy.sqlite");
  let legacy = openDb(file);
  try {
    legacy.prepare("INSERT INTO operators VALUES(?,?)").run("old", "旧用户");
    legacy
      .prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)")
      .run(
        "old-image",
        "旧图",
        "image/png",
        Buffer.from("legacy"),
        10,
        20,
        "old",
        "created",
        "created",
      );
    saveReview(legacy, "old-image", {
      actorId: "old",
      baseRevision: 0,
      annotations: [mark("历史批注")],
    });
    const before = review(legacy, "old-image");
    legacy.pragma("user_version=1");
    legacy.close();
    legacy = openDb(file);
    expect(review(legacy, "old-image").annotations).toEqual(before.annotations);
    expect(review(legacy, "old-image").image.revision).toBe(1);
    expect(review(legacy, "old-image").image.groupId).toBe("default-group");
    expect(
      legacy
        .prepare("SELECT operator_id FROM accounts WHERE username_key=?")
        .get("旧用户"),
    ).toEqual({ operator_id: "old" });
    legacy.close();
    legacy = openDb(file);
    expect(review(legacy, "old-image").annotations).toEqual(before.annotations);
    expect(legacy.pragma("user_version", { simple: true })).toBe(5);
  } finally {
    legacy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("照片与群组删除权限和事务", () => {
  it("只有上传者或组主能删照片，版本冲突不删数据，删除清理标记及归属", async () => {
    const owner = await register("组主"),
      uploader = await register("上传者"),
      member = await register("组员");
    const group = await create(owner.cookie, "图片删除测试");
    for (const user of [uploader, member])
      await send(`/api/groups/${group.id}/join`, user.cookie, "POST");
    const image = await upload(uploader.cookie, group.id);
    const a = mark();
    await send(`/api/images/${image.id}/annotations`, owner.cookie, "PUT", {
      baseRevision: 0,
      annotations: [a],
    });
    expect(
      (
        await send(`/api/images/${image.id}`, member.cookie, "DELETE", {
          baseRevision: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(`/api/images/${image.id}`, owner.cookie, "DELETE", {
          baseRevision: 0,
        })
      ).status,
    ).toBe(409);
    expect(review(db, image.id).annotations).toHaveLength(1);
    expect(
      (
        await send(`/api/images/${image.id}`, uploader.cookie, "DELETE", {
          baseRevision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(`/api/images/${image.id}/review`, owner.cookie)).status,
    ).toBe(404);
    expect(
      (
        db
          .prepare("SELECT count(*) AS n FROM annotations WHERE image_id=?")
          .get(image.id) as any
      ).n,
    ).toBe(0);
    expect(
      db.prepare("SELECT * FROM image_groups WHERE image_id=?").get(image.id),
    ).toBeUndefined();
    const other = await upload(uploader.cookie, group.id);
    expect(
      (
        await send(`/api/images/${other.id}`, owner.cookie, "DELETE", {
          baseRevision: 0,
        })
      ).status,
    ).toBe(200);
  });
  it("组主删除群组及所有照片标记，不能越权，其他组和账号保持", async () => {
    const owner = await register("甲组主"),
      member = await register("乙成员"),
      outsider = await register("丙");
    const group = await create(owner.cookie, "待删除组");
    await send(`/api/groups/${group.id}/join`, member.cookie, "POST");
    const image = await upload(member.cookie, group.id);
    await send(`/api/images/${image.id}/annotations`, member.cookie, "PUT", {
      baseRevision: 0,
      annotations: [mark()],
    });
    const retained = await create(member.cookie, "保留组");
    const retainedImage = await upload(member.cookie, retained.id);
    expect(
      (await send(`/api/groups/${group.id}`, member.cookie, "DELETE")).status,
    ).toBe(403);
    expect(
      (await send(`/api/groups/${group.id}`, outsider.cookie, "DELETE")).status,
    ).toBe(403);
    expect((await send(`/api/groups/${group.id}`, "", "DELETE")).status).toBe(
      401,
    );
    expect(
      (await send(`/api/groups/${group.id}`, owner.cookie, "DELETE")).status,
    ).toBe(200);
    for (const table of ["groups", "group_members"])
      expect(
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM ${table} WHERE ${table === "groups" ? "id" : "group_id"}=?`,
            )
            .get(group.id) as any
        ).n,
      ).toBe(0);
    expect(
      db.prepare("SELECT id FROM images WHERE id=?").get(image.id),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM annotations WHERE image_id=?").get(image.id),
    ).toBeUndefined();
    expect(
      (await send(`/api/images/${retainedImage.id}/review`, member.cookie))
        .status,
    ).toBe(200);
    expect(
      (await send("/api/auth/session", owner.cookie).then((r) => r.json())).user
        .id,
    ).toBe(owner.user.id);
    expect(
      (db.prepare("SELECT count(*) AS n FROM accounts").get() as any).n,
    ).toBe(3);
    expect(
      (await send(`/api/groups/${group.id}/join`, member.cookie, "POST"))
        .status,
    ).toBe(404);
  });
  it("删除群组中途异常时回滚图片、批注和成员", async () => {
    const { deleteGroup } = await import("../apps/api/src/deletions");
    const owner = await register("回滚测试");
    const group = await create(owner.cookie, "回滚组");
    const image = await upload(owner.cookie, group.id);
    saveReview(db, image.id, {
      actorId: owner.user.id,
      baseRevision: 0,
      annotations: [mark()],
    });
    const before = review(db, image.id);
    db.exec(
      "CREATE TEMP TRIGGER injected_delete_failure BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT,'INJECTED_DELETE_FAILURE'); END;",
    );
    expect(() => deleteGroup(db, group.id, owner.user.id)).toThrow(
      "INJECTED_DELETE_FAILURE",
    );
    expect(review(db, image.id)).toEqual(before);
    expect((await send(`/api/groups/${group.id}`, owner.cookie)).status).toBe(
      200,
    );
    expect(
      (
        db
          .prepare("SELECT count(*) AS n FROM group_members WHERE group_id=?")
          .get(group.id) as any
      ).n,
    ).toBe(1);
  });
  it("删除系统演示图片后初始化不复活，系统群组受保护，空图片库仍健康", async () => {
    const { seed } = await import("../apps/api/src/seed");
    await seed(db);
    const login = await send("/api/auth/login", "", "POST", { name: "小林" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(
      (await send("/api/groups/default-group", cookie, "DELETE")).status,
    ).toBe(403);
    for (const id of ["demo-poster", "demo-detail"])
      expect(
        (await send(`/api/images/${id}`, cookie, "DELETE", { baseRevision: 0 }))
          .status,
      ).toBe(200);
    await seed(db);
    expect(
      (db.prepare("SELECT count(*) AS n FROM images").get() as any).n,
    ).toBe(0);
    expect((await send("/api/health")).status).toBe(200);
    expect(
      await send("/api/images?groupId=default-group", cookie).then((r) =>
        r.json(),
      ),
    ).toEqual([]);
  });
});
