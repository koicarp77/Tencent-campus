import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Db } from "./database.js";
import { projectRoot } from "./database.js";
import {
  ApiError,
  fail,
  listImages,
  review,
  saveReview,
  patchReview,
  savedSubmission,
} from "./service.js";
import { MAX_BYTES, normalizeImage } from "./images.js";
import {
  sessionUser,
  login,
  logout,
  groups,
  groupInfo,
  createGroup,
  joinGroup,
  requireMember,
  requireImageMember,
} from "./collaboration.js";
import { deleteGroup, deleteImage } from "./deletions.js";
import { listDrafts, readDraft, writeDraft, clearDraft } from "./drafts.js";
import { createRealtime } from "./realtime.js";
export function createApp(db: Db) {
  const app = express();
  const realtime = createRealtime(db);
  app.locals.realtime = realtime;
  app.disable("x-powered-by");
  // Use the same loopback address as the listener and launcher. Redirect only
  // page navigation, never a POST: retrying an upload can create duplicates.
  app.get("/", (q, r, next) => {
    if (q.hostname !== "localhost") return next();
    r.set("Cache-Control", "no-store");
    r.redirect(302, `http://127.0.0.1:${q.socket.localPort}${q.originalUrl}`);
  });
  app.use("/api/images/:id/drafts", express.json({ limit: "2mb" }));
  app.use(express.json({ limit: "512kb" }));
  app.get("/api/health", (_q, r) => {
    db.prepare("SELECT 1").get();
    r.json({ ok: true });
  });
  app.use("/api/auth", (_q, r, next) => {
    r.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/auth/session", (q, r) => r.json({ user: sessionUser(db, q) }));
  app.post("/api/auth/register", (q, r) => {
    const user = login(db, q, r, true);
    realtime.revalidate();
    r.status(201).json({ user });
  });
  app.post("/api/auth/login", (q, r) => {
    const user = login(db, q, r, false);
    realtime.revalidate();
    r.json({ user });
  });
  app.post("/api/auth/logout", (q, r) => {
    logout(db, q, r);
    realtime.revalidate();
    r.json({ ok: true });
  });
  app.use("/api", (q, r, next) => {
    const user = sessionUser(db, q);
    if (!user) return fail(401, "LOGIN_REQUIRED", "登录已失效，请重新登录");
    r.locals.user = user;
    r.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/groups", (q, r) =>
    r.json(
      groups(
        db,
        r.locals.user.id,
        typeof q.query.search === "string" ? q.query.search : "",
      ),
    ),
  );
  app.post("/api/groups", (q, r) =>
    r.status(201).json(createGroup(db, r.locals.user.id, q.body?.name)),
  );
  app.get("/api/groups/:id", (q, r) =>
    r.json(groupInfo(db, q.params.id, r.locals.user.id)),
  );
  app.post("/api/groups/:id/join", (q, r) =>
    r.json(joinGroup(db, q.params.id, r.locals.user.id)),
  );
  app.get("/api/groups/:id/events", (q, r) => {
    realtime.connect(q, r, q.params.id, r.locals.user.id);
  });
  app.delete("/api/groups/:id", (q, r) => {
    const notify = realtime.afterGroupDeletion(q.params.id);
    const result = deleteGroup(db, q.params.id, r.locals.user.id);
    notify();
    r.json(result);
  });
  app.delete("/api/images/:id", (q, r) => {
    const groupId = requireImageMember(db, q.params.id, r.locals.user.id);
    const result = deleteImage(
      db,
      q.params.id,
      r.locals.user.id,
      q.body?.baseRevision,
    );
    realtime.publish(groupId, { type: "images", imageId: q.params.id });
    r.json(result);
  });
  app.use("/api/images/:id/drafts", (q, r, next) => {
    if (q.get("X-Draft-Owner") && q.get("X-Draft-Owner") !== r.locals.user.id)
      return fail(
        412,
        "ACCOUNT_CHANGED",
        "当前登录账号已变化，请刷新页面后继续，旧账号的草稿不会写入新账号",
      );
    next();
  });
  app.get("/api/images/:id/drafts", (q, r) =>
    r.json(listDrafts(db, q.params.id, r.locals.user.id)),
  );
  app.get("/api/images/:id/drafts/:draftId", (q, r) =>
    r.json(readDraft(db, q.params.id, r.locals.user.id, q.params.draftId)),
  );
  app.put("/api/images/:id/drafts/:draftId", (q, r) =>
    r.json(
      writeDraft(db, q.params.id, r.locals.user.id, q.params.draftId, q.body),
    ),
  );
  app.delete("/api/images/:id/drafts/:draftId", (q, r) =>
    r.json(
      clearDraft(
        db,
        q.params.id,
        r.locals.user.id,
        q.params.draftId,
        q.body?.expectedVersion,
      ),
    ),
  );
  app.get("/api/operators", (q, r) => {
    const groupId = requireMember(db, q.query.groupId, r.locals.user.id);
    r.json(
      db
        .prepare(
          "SELECT o.id,o.name FROM operators o JOIN group_members m ON m.operator_id=o.id WHERE m.group_id=? ORDER BY o.name,o.id",
        )
        .all(groupId),
    );
  });
  app.get("/api/images", (q, r) => {
    const groupId = requireMember(db, q.query.groupId, r.locals.user.id);
    r.json(listImages(db, groupId));
  });
  app.get("/api/images/:id/review", (q, r) => {
    requireImageMember(db, q.params.id, r.locals.user.id);
    r.json(review(db, q.params.id));
  });
  app.get("/api/images/:id/content", (q, r) => {
    requireImageMember(db, q.params.id, r.locals.user.id);
    const row = db
      .prepare("SELECT mime_type,image_blob FROM images WHERE id=?")
      .get(q.params.id) as any;
    if (!row) return fail(404, "IMAGE_NOT_FOUND", "图片不存在");
    r.set({
      "Content-Type": row.mime_type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }).send(row.image_blob);
  });
  app.get("/api/images/:id/submissions/:submissionId", (q, r) => {
    requireImageMember(db, q.params.id, r.locals.user.id);
    r.json(
      savedSubmission(db, q.params.id, q.params.submissionId, r.locals.user.id),
    );
  });
  app.patch("/api/images/:id/annotations", (q, r) => {
    const groupId = requireImageMember(db, q.params.id, r.locals.user.id);
    const result = patchReview(db, q.params.id, {
      ...q.body,
      actorId: r.locals.user.id,
    });
    realtime.publish(groupId, {
      type: "review",
      imageId: q.params.id,
      revision: result.image.revision,
    });
    r.json(result);
  });
  app.put("/api/images/:id/annotations", (q, r) => {
    const groupId = requireImageMember(db, q.params.id, r.locals.user.id);
    const result = saveReview(db, q.params.id, {
      ...q.body,
      actorId: r.locals.user.id,
    });
    realtime.publish(groupId, {
      type: "review",
      imageId: q.params.id,
      revision: result.image.revision,
    });
    r.json(result);
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 2, fieldSize: 1024 },
  });
  app.post(
    "/api/images",
    (q, r, next) => {
      r.locals.groupId = requireMember(db, q.query.groupId, r.locals.user.id);
      next();
    },
    upload.single("image"),
    async (q, r) => {
      if (!q.file) fail(400, "MISSING_IMAGE", "请选择图片");
      const title = String(q.body.title || q.file!.originalname).trim();
      if (!title || [...title].length > 100)
        fail(400, "INVALID_TITLE", "图片标题须为1—100个字符");
      const normalized = await normalizeImage(q.file!.buffer);
      const id = randomUUID();
      const t = new Date().toISOString();
      db.transaction(() => {
        requireMember(db, r.locals.groupId, r.locals.user.id);
        db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
          id,
          title,
          normalized!.mime,
          normalized!.data,
          normalized!.width,
          normalized!.height,
          r.locals.user.id,
          t,
          t,
        );
        db.prepare("INSERT INTO image_groups VALUES(?,?)").run(
          id,
          r.locals.groupId,
        );
      })();
      realtime.publish(r.locals.groupId, { type: "images", imageId: id });
      r.status(201).json(review(db, id));
    },
  );
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
