import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type Db } from "../apps/api/src/database";
import { patchReview, review, saveReview } from "../apps/api/src/service";
let db: Db;
const mark = (content = "原文") => ({
  id: randomUUID(),
  x: 0.25,
  y: 0.3,
  content,
  sortOrder: 0,
});
const patch = (
  baseRevision: number,
  operations: any,
  actorId = "a",
  submissionId = randomUUID(),
  afterWrite?: () => void,
) =>
  patchReview(
    db,
    "i",
    {
      actorId,
      baseRevision,
      submissionId,
      added: [],
      updated: [],
      deleted: [],
      ...operations,
    },
    afterWrite,
  );
beforeEach(() => {
  db = openDb(":memory:");
  db.exec("INSERT INTO operators VALUES('a','甲'),('b','乙');");
  db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
    "i",
    "图",
    "image/png",
    Buffer.from("test"),
    10,
    10,
    "a",
    "initial",
    "initial",
  );
});
afterEach(() => db.close());
it("100个标记中只修改1个，其余99条数据库记录不被更新或重建", () => {
  const all = Array.from({ length: 100 }, () => mark());
  patch(0, { added: all });
  const id = all[7].id;
  db.exec(`CREATE TRIGGER untouched_update BEFORE UPDATE ON annotations WHEN OLD.id!='${id}' BEGIN SELECT RAISE(ABORT,'untouched updated'); END;
 CREATE TRIGGER untouched_delete BEFORE DELETE ON annotations BEGIN SELECT RAISE(ABORT,'untouched deleted'); END;
 CREATE TRIGGER untouched_insert BEFORE INSERT ON annotations BEGIN SELECT RAISE(ABORT,'untouched reinserted'); END;`);
  const result = patch(1, { updated: [{ ...all[7], content: "只改第8条" }] });
  expect(result.annotations).toHaveLength(100);
  expect(result.annotations[7].content).toBe("只改第8条");
  expect(result.annotations[6].updatedAt).toBe(result.annotations[6].createdAt);
});
it("不同位置、同一位置的独立新增均保留，遗漏不代表删除", () => {
  const a = mark("甲"),
    b = mark("乙同位置"),
    c = { ...mark("乙不同位置"), x: 0.75 };
  patch(0, { added: [a] });
  const r = patch(0, { added: [b, c] }, "b");
  expect(r.annotations.map((a) => a.content)).toEqual([
    "甲",
    "乙同位置",
    "乙不同位置",
  ]);
  expect(new Set(r.annotations.map((a) => a.id)).size).toBe(3);
});
it("两人修改同一标记分别保留；同一提交重试不重复分叉", () => {
  const a = mark();
  patch(0, { added: [a] });
  patch(1, { updated: [{ ...a, content: "甲" }] });
  const operations = { updated: [{ ...a, content: "乙" }] },
    id = randomUUID();
  const r = patch(1, operations, "b", id);
  expect(r.annotations.map((a) => a.content)).toEqual(["甲", "乙"]);
  expect(patch(1, operations, "b", id)).toEqual(r);
  expect(review(db, "i").image.revision).toBe(3);
  expect(() =>
    patch(1, { updated: [{ ...a, content: "偷换" }] }, "b", id),
  ).toThrow("已被其他内容");
});
it.each([true, false])(
  "修改/删除两种到达顺序都保留修改（修改先到=%s）",
  (updateFirst) => {
    const a = mark(),
      other = mark("无关");
    patch(0, { added: [a, other] });
    const modification = { updated: [{ ...a, content: "乙的新说明" }] },
      deletion = { deleted: [a.id] };
    patch(1, updateFirst ? modification : deletion, updateFirst ? "b" : "a");
    const r = patch(
      1,
      updateFirst ? deletion : modification,
      updateFirst ? "a" : "b",
    );
    expect(r.annotations.map((a) => a.content)).toContain("乙的新说明");
    expect(r.annotations.map((a) => a.content)).toContain("无关");
    const saved = r.annotations.find((a) => a.content === "乙的新说明")!;
    expect(saved.id === a.id).toBe(updateFirst);
    expect(
      patch(r.image.revision, { deleted: [saved.id] }).annotations.map(
        (a) => a.content,
      ),
    ).toEqual(["无关"]);
  },
);
it("独立修改不互相覆盖；批量新增修改删除原子执行", () => {
  const a = mark("甲"),
    b = mark("乙"),
    c = mark("丙");
  patch(0, { added: [a, b] });
  patch(1, { updated: [{ ...a, content: "甲更新" }] });
  const r = patch(
    1,
    { updated: [{ ...b, content: "乙更新" }], added: [c] },
    "b",
  );
  expect(r.annotations.map((a) => a.content)).toEqual([
    "甲更新",
    "乙更新",
    "丙",
  ]);
  const before = review(db, "i");
  expect(() =>
    patch(
      3,
      { deleted: [a.id], updated: [{ ...b, content: "失败" }] },
      "b",
      randomUUID(),
      () => {
        throw new Error("injected");
      },
    ),
  ).toThrow("injected");
  expect(review(db, "i")).toEqual(before);
});
it("校验重复操作、非法内容、错误操作类型、空请求、未来版本与合并超限", () => {
  const a = mark();
  patch(0, { added: [a] });
  const before = review(db, "i");
  for (const op of [
    { added: [a] },
    { updated: [mark()] },
    { deleted: [randomUUID()] },
    { updated: [a], deleted: [a.id] },
    { deleted: [a.id, a.id] },
    { updated: [{ ...a, content: "" }] },
    { annotations: [] },
    {},
  ])
    expect(() => patch(1, op)).toThrow();
  expect(() => patch(99, { updated: [a] })).toThrow("基准不可用");
  expect(review(db, "i")).toEqual(before);
  patch(1, { added: Array.from({ length: 99 }, () => mark()) });
  expect(() => patch(1, { added: [mark()] }, "b")).toThrow("超过100");
  expect(review(db, "i").annotations).toHaveLength(100);
});
it("旧PUT兼容，新增量PATCH可基于旧PUT产生的版本继续编辑", () => {
  const a = mark();
  saveReview(db, "i", { actorId: "a", baseRevision: 0, annotations: [a] });
  expect(
    patch(1, { updated: [{ ...a, content: "增量编辑" }] }).annotations[0]
      .content,
  ).toBe("增量编辑");
});
