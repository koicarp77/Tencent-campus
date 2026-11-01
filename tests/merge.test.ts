import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type Db } from "../apps/api/src/database";
import { saveReview, review, savedSubmission } from "../apps/api/src/service";
let db: Db;
const mark = (content = "原说明") => ({
  id: randomUUID(),
  x: 0.25,
  y: 0.3,
  content,
  sortOrder: 0,
});
const save = (
  annotations: any[],
  baseRevision = 0,
  actorId = "a",
  submissionId?: string,
) => saveReview(db, "i", { annotations, baseRevision, actorId, submissionId });
beforeEach(() => {
  db = openDb(":memory:");
  db.exec("INSERT INTO operators VALUES('a','甲'),('b','乙');");
  db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
    "i",
    "图片",
    "image/png",
    Buffer.from("test"),
    10,
    10,
    "a",
    "initial",
    "initial",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
it("同标记不同修改独立保存，服务器时间严格递增，原历史保留", () => {
  const a = mark();
  save([a]);
  vi.spyOn(Date, "now").mockReturnValue(0);
  const first = save([{ ...a, content: "甲修改" }], 1, "a");
  const second = save(
    [{ ...a, content: "乙修改", updatedAt: "2099-01-01" }],
    1,
    "b",
  );
  expect(second.annotations.map((a) => a.content)).toEqual([
    "甲修改",
    "乙修改",
  ]);
  expect(second.annotations[0].id).toBe(a.id);
  expect(second.annotations[1].id).not.toBe(a.id);
  expect(second.annotations[1].createdBy).toBe("b");
  expect(second.annotations[1].createdAt).toBe(second.savedAt);
  expect(Date.parse(second.savedAt)).toBeGreaterThan(Date.parse(first.savedAt));
  expect(second.mergeInfo?.forks).toEqual([
    { originalId: a.id, newId: second.annotations[1].id },
  ]);
});
it("旧页面未修改的内容不覆盖新修改，也不删除别人新增的标记", () => {
  const a = mark(),
    b = mark("乙新增"),
    c = mark("甲新增");
  save([a]);
  save([{ ...a, content: "乙修改" }, b], 1, "b");
  const r = save([a, c], 1, "a");
  expect(r.annotations.map((a) => a.content)).toEqual([
    "乙修改",
    "乙新增",
    "甲新增",
  ]);
});
it("删除与修改冲突保留修改；修改已删除的标记另存新ID", () => {
  const a = mark();
  save([a]);
  save([{ ...a, content: "乙修改" }], 1, "b");
  const kept = save([], 1, "a");
  expect(kept.annotations[0].content).toBe("乙修改");
  expect(kept.mergeInfo?.preservedDeletions).toBe(1);
  save([], 3, "a");
  const restored = save([{ ...a, content: "乙另改" }], 3, "b");
  expect(restored.annotations).toHaveLength(1);
  expect(restored.annotations[0].id).not.toBe(a.id);
});
it("完全相同的并发修改不复制，未修改的旧页面不复活已删除标记", () => {
  const a = mark(),
    b = mark("新增");
  save([a]);
  save([{ ...a, content: "相同" }], 1);
  expect(save([{ ...a, content: "相同" }], 1, "b").annotations).toHaveLength(1);
  save([], 3);
  expect(
    save([{ ...a, content: "相同" }, b], 3, "b").annotations.map(
      (a) => a.content,
    ),
  ).toEqual(["新增"]);
});
it("同一提交重试返回原结果，不重复复制或递增版本；提交ID不能换内容或用户", () => {
  const a = mark();
  save([a]);
  save([{ ...a, content: "甲" }], 1);
  const id = randomUUID();
  const r = save([{ ...a, content: "乙" }], 1, "b", id);
  expect(save([{ ...a, content: "乙" }], 1, "b", id)).toEqual(r);
  expect(review(db, "i").image.revision).toBe(3);
  expect(review(db, "i").annotations).toHaveLength(2);
  expect(savedSubmission(db, "i", id, "b").review).toEqual(r);
  expect(() => savedSubmission(db, "i", id, "a")).toThrow("无成功记录");
  expect(() => save([{ ...a, content: "更换" }], 1, "b", id)).toThrow(
    "已被其他内容",
  );
  expect(() => save([{ ...a, content: "乙" }], 1, "a", id)).toThrow(
    "已被其他内容",
  );
});
it("合并超过100条、缺少旧版本基准时整体不写入", () => {
  const old = Array.from({ length: 100 }, () => mark());
  save(old);
  const before = review(db, "i");
  expect(() => save([mark("旧页新增")], 0, "b")).toThrow("超过100");
  expect(review(db, "i")).toEqual(before);
  expect(() => save([], 99)).toThrow("基准不可用");
  expect(review(db, "i")).toEqual(before);
});
it("事务中断同时回滚版本快照与提交收据", () => {
  const a = mark();
  save([a]);
  const id = randomUUID();
  const before = review(db, "i");
  expect(() =>
    saveReview(
      db,
      "i",
      {
        annotations: [{ ...a, content: "失败" }],
        baseRevision: 1,
        actorId: "b",
        submissionId: id,
      },
      () => {
        throw new Error("injected");
      },
    ),
  ).toThrow("injected");
  expect(review(db, "i")).toEqual(before);
  expect(
    db.prepare("SELECT count(*) n FROM review_versions WHERE revision=2").get(),
  ).toEqual({ n: 0 });
  expect(() => savedSubmission(db, "i", id, "b")).toThrow();
});
