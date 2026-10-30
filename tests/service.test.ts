import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type Db } from "../apps/api/src/database";
import { saveReview, review, validateSave } from "../apps/api/src/service";
import { point, centerAnchor } from "../apps/web/src/coordinates";
import { normalizeImage } from "../apps/api/src/images";
import sharp from "sharp";
import { createApp } from "../apps/api/src/app";
import { business } from "../packages/shared/src/contracts";
let db: Db;
const mark = (content = "检查价格") => ({
  id: randomUUID(),
  x: 0.25,
  y: 0.6,
  content,
  sortOrder: 0,
});
const body = (annotations: any[], baseRevision = 0, actorId = "a") => ({
  actorId,
  baseRevision,
  annotations,
});
beforeEach(() => {
  db = openDb(":memory:");
  db.exec("INSERT INTO operators VALUES('a','甲'),('b','乙');");
  for (const id of ["i", "j"])
    db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
      id,
      "同名图片",
      "image/png",
      Buffer.from("test"),
      900,
      1200,
      "a",
      "initial",
      "initial",
    );
});
afterEach(() => db.close());
describe("真实SQLite整图事务", () => {
  it("保存、保留历史、删除重排、仅实际修改者更新、清空", () => {
    const a = mark(),
      b = mark("第二条");
    saveReview(db, "i", body([a, b]));
    const first = review(db, "i");
    saveReview(db, "i", body([{ ...a, content: "新价格" }, b], 1, "b"));
    let latest = review(db, "i");
    expect(latest.annotations[0].createdBy).toBe("a");
    expect(latest.annotations[0].updatedBy).toBe("b");
    expect(latest.annotations[1]).toEqual(first.annotations[1]);
    saveReview(db, "i", body([b], 2, "b"));
    expect(review(db, "i").annotations[0]).toEqual({
      ...first.annotations[1],
      sortOrder: 0,
    });
    saveReview(db, "i", body([], 3));
    expect(review(db, "i").annotations).toEqual([]);
  });
  it("旧版本409，不覆盖已保存数据", () => {
    saveReview(db, "i", body([mark("A")]));
    expect(() => saveReview(db, "i", body([mark("B")]))).toThrow("其他人");
    expect(review(db, "i").annotations[0].content).toBe("A");
  });
  it("中途写入抛异常时，revision和所有批注历史一起回滚", () => {
    const a = mark();
    saveReview(db, "i", body([a]));
    const before = review(db, "i");
    expect(() =>
      saveReview(
        db,
        "i",
        body([{ ...a, content: "失败写入" }, mark()], 1),
        () => {
          throw new Error("INJECTED_AFTER_FIRST_WRITE");
        },
      ),
    ).toThrow("INJECTED");
    expect(review(db, "i")).toEqual(before);
  });
  it("拒绝跨图片标记ID，不改变两图数据", () => {
    const a = mark();
    saveReview(db, "i", body([a]));
    expect(() => saveReview(db, "j", body([a]))).toThrow("其他图片");
    expect(review(db, "j").image.revision).toBe(0);
  });
  it.each(
    [
      [mark("")],
      [mark("字".repeat(501))],
      [{ ...mark(), x: 1.2 }],
      [{ ...mark(), x: "0.2" }],
      [{ ...mark(), y: NaN }],
    ].map((annotations) => ({ annotations })),
  )("拒绝非法输入 $annotations", ({ annotations }) => {
    expect(() => saveReview(db, "i", body(annotations))).toThrow();
    expect(review(db, "i").image.revision).toBe(0);
  });
  it("重复ID、未知操作人、非法版本、101条均拒绝", () => {
    const a = mark();
    for (const input of [
      body([a, a]),
      body([a], 0, "unknown"),
      body([a], -1),
      body(Array.from({ length: 101 }, () => mark())),
    ])
      expect(() => saveReview(db, "i", input)).toThrow();
  });
  it("说明按Unicode码点计算，裁剪首尾空白", () => {
    const a = mark("  " + "😀".repeat(500) + "  ");
    saveReview(db, "i", body([a]));
    expect(review(db, "i").annotations[0].content).toBe("😀".repeat(500));
    expect(() => validateSave(body([mark("😀".repeat(501))]))).toThrow();
  });
  it("HTTP保存100×500个中文字不触发默认100KB限制", async () => {
    const server = createApp(db).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const port = (server.address() as any).port;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/images/i/annotations`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            body(Array.from({ length: 100 }, () => mark("中".repeat(500)))),
          ),
        },
      );
      expect(response.status).toBe(200);
      expect(review(db, "i").annotations).toHaveLength(100);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
describe("坐标与业务快照", () => {
  it("使用视口坐标，不重复累加滚动，排除留白和未加载图片", () => {
    expect(
      point(150, 260, { left: 100, top: 200, width: 200, height: 100 }),
    ).toEqual({ x: 0.25, y: 0.6 });
    expect(
      point(99, 200, { left: 100, top: 200, width: 200, height: 100 }),
    ).toBeNull();
    expect(point(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
  it("缩放锚点使用视口中心并夹取边界", () => {
    expect(
      centerAnchor(
        { left: 0, top: 0, width: 100, height: 100 },
        { left: 0, top: -150, width: 200, height: 400 },
      ),
    ).toEqual({ x: 0.25, y: 0.5 });
    expect(
      centerAnchor(
        { left: 0, top: 0, width: 100, height: 100 },
        { left: 100, top: 100, width: 100, height: 100 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });
  it("结果核对忽略历史字段，规范化空白和顺序", () => {
    const a = mark("  文案 ");
    expect(business([a])).toBe(
      business([{ ...a, content: "文案", sortOrder: 7, updatedBy: "b" }]),
    );
  });
});
describe("真实解码上传边界", () => {
  it("PNG尺寸、MIME和输出一致；移除EXIF", async () => {
    const b = await sharp({
      create: { width: 50, height: 80, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await normalizeImage(b);
    expect(out!.width).toBe(80);
    expect(out!.height).toBe(50);
    expect(out!.mime).toBe("image/jpeg");
    expect((await sharp(out!.data).metadata()).orientation).toBeUndefined();
  });
  it("损坏、伪装SVG、原始体积、处理后体积分别拒绝", async () => {
    await expect(normalizeImage(Buffer.from("bad.png"))).rejects.toThrow(
      "解码",
    );
    const svg = Buffer.from('<svg width="10" height="10"></svg>');
    await expect(normalizeImage(svg)).rejects.toThrow();
    await expect(
      normalizeImage(Buffer.alloc(10 * 1024 * 1024 + 1)),
    ).rejects.toThrow("原始");
    const b = await sharp({
      create: { width: 50, height: 80, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(normalizeImage(b, 1)).rejects.toThrow("处理后");
  });
  it("2000万像素解码入口限制", async () => {
    const b = await sharp({
      create: { width: 5000, height: 4001, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(normalizeImage(b)).rejects.toThrow("2000万");
  });
  it("拒绝真实两帧WebP动画", async () => {
    const header = "47494638396101000100800000000000ffffff",
      frame = "21f904000a0000002c0000000001000100000202";
    const gif = Buffer.from(
      header + frame + "440100" + frame + "4c0100" + "3b",
      "hex",
    );
    const webp = await sharp(gif, { animated: true }).webp().toBuffer();
    expect((await sharp(webp, { animated: true }).metadata()).pages).toBe(2);
    await expect(normalizeImage(webp)).rejects.toThrow("动画");
  });
  it("拒绝静态GIF", async () => {
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    await expect(normalizeImage(gif)).rejects.toThrow("只接受");
  });
});

describe("上传API与持久化边界", () => {
  it("上传有效图片按真实格式入库；损坏上传不留半条记录", async () => {
    const server = createApp(db).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const url = `http://127.0.0.1:${(server.address() as any).port}/api/images`;
    try {
      const buffer = await sharp({
        create: { width: 24, height: 30, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer();
      const form = new FormData();
      form.append("actorId", "a");
      form.append("image", new Blob([buffer]), "pretend.jpg");
      const response = await fetch(url, { method: "POST", body: form });
      expect(response.status).toBe(201);
      const image = (await response.json()).image;
      expect(image.width).toBe(24);
      expect(image.height).toBe(30);
      const row = db
        .prepare("SELECT mime_type,image_blob FROM images WHERE id=?")
        .get(image.id) as any;
      expect(row.mime_type).toBe("image/png");
      expect((await sharp(row.image_blob).metadata()).width).toBe(24);
      const count = () =>
        (db.prepare("SELECT count(*) AS n FROM images").get() as any).n;
      const before = count();
      for (const bytes of [
        Buffer.from("not an image"),
        Buffer.alloc(10 * 1024 * 1024 + 1),
      ]) {
        const bad = new FormData();
        bad.append("actorId", "a");
        bad.append("image", new Blob([bytes]), "broken.png");
        const result = await fetch(url, { method: "POST", body: bad });
        expect([413, 415]).toContain(result.status);
        expect(count()).toBe(before);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
