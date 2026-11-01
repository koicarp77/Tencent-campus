import { beforeEach, afterEach, it, expect } from "vitest";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { openDb, type Db } from "../apps/api/src/database";
import { createApp } from "../apps/api/src/app";

let db: Db, server: Server, base: string, app: ReturnType<typeof createApp>;
const controllers: AbortController[] = [];
const user = (name: string) =>
  send("/api/auth/register", "", "POST", { name }).then(async (r) => ({
    cookie: r.headers.get("set-cookie")!.split(";")[0],
    user: (await r.json()).user,
  }));
function send(path: string, cookie = "", method = "GET", data?: any) {
  return fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
async function fixture(name = "甲") {
  const account = await user(name);
  await send("/api/groups/default-group/join", account.cookie, "POST");
  return account;
}
function image(owner: string, id = "image", group = "default-group") {
  db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
    id,
    id,
    "image/png",
    Buffer.from("test"),
    10,
    10,
    owner,
    "initial",
    "initial",
  );
  db.prepare("INSERT INTO image_groups VALUES(?,?)").run(id, group);
}
const mark = () => ({
  id: randomUUID(),
  x: 0.25,
  y: 0.3,
  content: "不应被推送的正文",
  sortOrder: 0,
});
async function connect(cookie: string, id: string, group = "default-group") {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(
    `${base}/api/groups/${group}/events?owner=${id}`,
    { headers: { Cookie: cookie }, signal: controller.signal },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events: { type: string; data: any }[] = [];
  let finished = false;
  const reader = response.body!.getReader();
  const pump = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) throw e;
    } finally {
      finished = true;
    }
  })();
  await expect.poll(() => events[0]?.type).toBe("ready");
  return {
    events,
    controller,
    pump,
    get finished() {
      return finished;
    },
  };
}
beforeEach(async () => {
  db = openDb(":memory:");
  app = createApp(db);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  for (const controller of controllers) controller.abort();
  controllers.length = 0;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});
it("SSE需要有效会话、群组成员和匹配owner，不接受跨账号重连", async () => {
  const a = await fixture(),
    b = await user("乙");
  expect(
    (await send(`/api/groups/default-group/events?owner=${a.user.id}`)).status,
  ).toBe(401);
  expect(
    (
      await send(
        `/api/groups/default-group/events?owner=${b.user.id}`,
        b.cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await send(
        `/api/groups/default-group/events?owner=${b.user.id}`,
        a.cookie,
      )
    ).status,
  ).toBe(412);
  expect(
    (await send(`/api/groups/default-group/events`, a.cookie)).status,
  ).toBe(412);
  const stream = await connect(a.cookie, a.user.id);
  expect(app.locals.realtime.size).toBe(1);
  stream.controller.abort();
  await stream.pump;
  await expect.poll(() => app.locals.realtime.size).toBe(0);
});
it("只向同组成员推送成功的正式保存，无正文；失败和私人草稿不推送", async () => {
  const a = await fixture(),
    b = await fixture("乙");
  image(a.user.id);
  const other = await send("/api/groups", b.cookie, "POST", {
    name: "另一组",
  }).then((r) => r.json());
  image(b.user.id, "other", other.id);
  const stream = await connect(a.cookie, a.user.id),
    separate = await connect(b.cookie, b.user.id, other.id);
  const annotation = mark();
  const draftId = randomUUID();
  expect(
    (
      await send(`/api/images/image/drafts/${draftId}`, a.cookie, "PUT", {
        expectedVersion: 0,
        baseRevision: 0,
        baseAnnotations: [],
        annotations: [annotation],
        selectedId: annotation.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send("/api/images/image/annotations", a.cookie, "PATCH", {
        submissionId: randomUUID(),
        baseRevision: 0,
        added: [{ ...annotation, content: "" }],
        updated: [],
        deleted: [],
      })
    ).status,
  ).toBe(400);
  const result = await send(
    "/api/images/image/annotations",
    a.cookie,
    "PATCH",
    {
      submissionId: randomUUID(),
      baseRevision: 0,
      added: [annotation],
      updated: [],
      deleted: [],
    },
  );
  expect(result.status).toBe(200);
  await expect.poll(() => stream.events.length).toBe(2);
  expect(stream.events[1]).toEqual({
    type: "change",
    data: { type: "review", imageId: "image", revision: 1 },
  });
  expect(JSON.stringify(stream.events)).not.toContain(annotation.content);
  expect(
    (
      await send("/api/images/other/annotations", b.cookie, "PUT", {
        baseRevision: 0,
        annotations: [mark()],
      })
    ).status,
  ).toBe(200);
  await expect.poll(() => separate.events.length).toBe(2);
  expect(separate.events[1].data.imageId).toBe("other");
  expect(stream.events).toHaveLength(2);
});
it("会话登出立即撤销已建立连接，后续不再收到修改通知", async () => {
  const a = await fixture(),
    b = await fixture("乙");
  image(b.user.id);
  const stream = await connect(a.cookie, a.user.id);
  expect((await send("/api/auth/logout", a.cookie, "POST")).status).toBe(200);
  await expect.poll(() => stream.finished).toBe(true);
  expect(stream.events.at(-1)?.type).toBe("access-lost");
  expect(app.locals.realtime.size).toBe(0);
  await send("/api/images/image/annotations", b.cookie, "PUT", {
    baseRevision: 0,
    annotations: [mark()],
  });
  expect(stream.events.filter((e) => e.type === "change")).toHaveLength(0);
});
it("已有连接成员权限被撤销后，在广播前重新校验并关闭", async () => {
  const a = await fixture(),
    b = await fixture("乙");
  image(b.user.id);
  const stream = await connect(a.cookie, a.user.id);
  db.prepare(
    "DELETE FROM group_members WHERE group_id=? AND operator_id=?",
  ).run("default-group", a.user.id);
  await send("/api/images/image/annotations", b.cookie, "PUT", {
    baseRevision: 0,
    annotations: [mark()],
  });
  await expect.poll(() => stream.finished).toBe(true);
  expect(stream.events.at(-1)?.type).toBe("access-lost");
  expect(stream.events.filter((e) => e.type === "change")).toHaveLength(0);
});
it("上传、删除图片广播images，删除群组通知原成员并关闭连接", async () => {
  const a = await fixture();
  const group = await send("/api/groups", a.cookie, "POST", {
    name: "临时审核组",
  }).then((r) => r.json());
  const stream = await connect(a.cookie, a.user.id, group.id);
  const data = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("image", new Blob([data]), "test.png");
  const uploaded = await fetch(`${base}/api/images?groupId=${group.id}`, {
    method: "POST",
    headers: { Cookie: a.cookie },
    body: form,
  }).then((r) => r.json());
  await expect.poll(() => stream.events.length).toBe(2);
  expect(stream.events[1].data).toEqual({
    type: "images",
    imageId: uploaded.image.id,
  });
  expect(
    (
      await send(`/api/images/${uploaded.image.id}`, a.cookie, "DELETE", {
        baseRevision: 0,
      })
    ).status,
  ).toBe(200);
  await expect.poll(() => stream.events.length).toBe(3);
  expect(stream.events[2].data).toEqual({
    type: "images",
    imageId: uploaded.image.id,
  });
  expect(
    (await send(`/api/groups/${group.id}`, a.cookie, "DELETE")).status,
  ).toBe(200);
  await expect.poll(() => stream.finished).toBe(true);
  expect(stream.events.at(-1)).toEqual({
    type: "change",
    data: { type: "group-deleted" },
  });
  expect(app.locals.realtime.size).toBe(0);
});
it("数据库删除回滚不发群组删除事件，连接继续收到后续正式更新", async () => {
  const a = await fixture();
  const group = await send("/api/groups", a.cookie, "POST", {
    name: "失败组",
  }).then((r) => r.json());
  image(a.user.id, "image", group.id);
  const stream = await connect(a.cookie, a.user.id, group.id);
  db.exec(
    "CREATE TRIGGER abort_group_delete BEFORE DELETE ON groups BEGIN SELECT RAISE(ABORT,'INJECTED'); END;",
  );
  expect(
    (await send(`/api/groups/${group.id}`, a.cookie, "DELETE")).status,
  ).toBe(500);
  expect(
    (
      await send("/api/images/image/annotations", a.cookie, "PUT", {
        baseRevision: 0,
        annotations: [mark()],
      })
    ).status,
  ).toBe(200);
  await expect.poll(() => stream.events.length).toBe(2);
  expect(stream.events[1].data.type).toBe("review");
  expect(stream.finished).toBe(false);
});

it("服务停止时主动结束SSE长连接，server.close不会被长连接阻塞", async () => {
  const a = await fixture();
  const stream = await connect(a.cookie, a.user.id);
  app.locals.realtime.closeAll();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await stream.pump;
  expect(stream.finished).toBe(true);
  expect(app.locals.realtime.size).toBe(0);
});
