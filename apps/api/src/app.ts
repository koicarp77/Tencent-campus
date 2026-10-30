import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Db } from "./database.js";
import { projectRoot } from "./database.js";
import {
  ApiError,
  actor,
  fail,
  listImages,
  review,
  saveReview,
} from "./service.js";
import { MAX_BYTES, normalizeImage } from "./images.js";
export function createApp(db: Db) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.get("/api/health", (_q, r) => {
    db.prepare("SELECT 1").get();
    r.json({ ok: true });
  });
  app.get("/api/operators", (_q, r) =>
    r.json(db.prepare("SELECT * FROM operators ORDER BY id").all()),
  );
  app.get("/api/images", (_q, r) => r.json(listImages(db)));
  app.get("/api/images/:id/review", (q, r) => r.json(review(db, q.params.id)));
  app.get("/api/images/:id/content", (q, r) => {
    const row = db
      .prepare("SELECT mime_type,image_blob FROM images WHERE id=?")
      .get(q.params.id) as any;
    if (!row) return fail(404, "IMAGE_NOT_FOUND", "图片不存在");
    r.set({
      "Content-Type": row.mime_type,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    }).send(row.image_blob);
  });
  app.put("/api/images/:id/annotations", (q, r) =>
    r.json(saveReview(db, q.params.id, q.body)),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 2, fieldSize: 1024 },
  });
  app.post("/api/images", upload.single("image"), async (q, r) => {
    actor(db, q.body.actorId);
    if (!q.file) fail(400, "MISSING_IMAGE", "请选择图片");
    const title = String(q.body.title || q.file!.originalname).trim();
    if (!title || [...title].length > 100)
      fail(400, "INVALID_TITLE", "图片标题须为1—100个字符");
    const normalized = await normalizeImage(q.file!.buffer);
    const id = randomUUID();
    const t = new Date().toISOString();
    db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
      id,
      title,
      normalized!.mime,
      normalized!.data,
      normalized!.width,
      normalized!.height,
      q.body.actorId,
      t,
      t,
    );
    r.status(201).json(review(db, id));
  });
  app.use("/api", (_q, _r) => fail(404, "NOT_FOUND", "接口不存在"));
  const web = resolve(projectRoot, "dist/web");
  if (existsSync(web)) {
    app.use(express.static(web));
    app.get("/", (_q, r) => r.sendFile(resolve(web, "index.html")));
  }
  app.use(
    (
      e: any,
      _q: express.Request,
      r: express.Response,
      _n: express.NextFunction,
    ) => {
      if (e instanceof ApiError) {
        r.status(e.status).json({ code: e.code, message: e.message });
        return;
      }
      if (e instanceof multer.MulterError) {
        r.status(e.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
          code: e.code,
          message:
            e.code === "LIMIT_FILE_SIZE"
              ? "原始图片超过10MiB"
              : "上传字段或文件数量超出限制",
        });
        return;
      }
      if (e.type === "entity.too.large") {
        r.status(413).json({ code: "BODY_TOO_LARGE", message: "请求体过大" });
        return;
      }
      if (e instanceof SyntaxError) {
        r.status(400).json({ code: "INVALID_JSON", message: "JSON格式无效" });
        return;
      }
      console.error(e);
      r.status(500).json({
        code: "INTERNAL_ERROR",
        message: "服务器保存失败，请稍后重试",
      });
    },
  );
  return app;
}
