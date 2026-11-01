import type { Db } from "./database.js";
import {
  DEFAULT_GROUP,
  requireImageMember,
  requireMember,
} from "./collaboration.js";
import { fail } from "./service.js";

export function deleteImage(
  db: Db,
  id: string,
  userId: string,
  baseRevision: unknown,
) {
  return db.transaction(() => {
    const groupId = requireImageMember(db, id, userId);
    const image = db
      .prepare("SELECT revision,created_by FROM images WHERE id=?")
      .get(id) as any;
    const group = db
      .prepare("SELECT created_by FROM groups WHERE id=?")
      .get(groupId) as any;
    if (image.created_by !== userId && group.created_by !== userId)
      fail(
        403,
        "CANNOT_DELETE_IMAGE",
        "仅图片上传者或群组创建者可以删除这张图片",
      );
    if (!Number.isSafeInteger(baseRevision) || Number(baseRevision) < 0)
      fail(400, "INVALID_REVISION", "缺少有效图片版本，请刷新后重试");
    if (image.revision !== baseRevision)
      fail(
        409,
        "REVISION_CONFLICT",
        "这张图片的标记已更新，请先加载最新版本，再确认删除",
      );
    db.prepare("DELETE FROM annotations WHERE image_id=?").run(id);
    if (["demo-poster", "demo-detail"].includes(id))
      db.prepare("INSERT OR IGNORE INTO deleted_seed_images VALUES(?,?)").run(
        id,
        new Date().toISOString(),
      );
    // image_groups follows its image through ON DELETE CASCADE.
    db.prepare("DELETE FROM images WHERE id=?").run(id);
    return { ok: true };
  })();
}
export function deleteGroup(db: Db, id: string, userId: string) {
  return db.transaction(() => {
    requireMember(db, id, userId);
    const group = db
      .prepare("SELECT created_by FROM groups WHERE id=?")
      .get(id) as any;
    if (id === DEFAULT_GROUP)
      fail(403, "SYSTEM_GROUP", "默认协作组是系统群组，不能删除");
    if (group.created_by !== userId)
      fail(403, "CANNOT_DELETE_GROUP", "只有群组创建者可以删除群组");
    db.prepare(
      "DELETE FROM annotations WHERE image_id IN (SELECT image_id FROM image_groups WHERE group_id=?)",
    ).run(id);
    db.prepare(
      "DELETE FROM images WHERE id IN (SELECT image_id FROM image_groups WHERE group_id=?)",
    ).run(id);
    // Membership rows cascade; account and session rows are preserved.
    db.prepare("DELETE FROM groups WHERE id=?").run(id);
    return { ok: true };
  })();
}
