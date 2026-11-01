import type { Db } from "./database.js";
import { fail, validateSave } from "./service.js";
import { requireImageMember } from "./collaboration.js";
import type {
  DraftBackup,
  Annotation,
} from "../../../packages/shared/src/contracts.js";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail(400, "INVALID_DRAFT_VERSION", "草稿版本无效");
  return value as number;
}
function draftId(value: string) {
  if (!uuid.test(value)) fail(400, "INVALID_DRAFT_ID", "草稿ID无效");
}
const select =
  "SELECT id,base_revision AS baseRevision,base_annotations AS baseAnnotations,annotations,selected_id AS selectedId,version,cleared,updated_at AS updatedAt FROM review_drafts";
function decode(row: any): DraftBackup {
  return {
    ...row,
    baseAnnotations: JSON.parse(row.baseAnnotations),
    annotations: JSON.parse(row.annotations),
    cleared: !!row.cleared,
  };
}
export function listDrafts(db: Db, imageId: string, userId: string) {
  requireImageMember(db, imageId, userId);
  return db
    .prepare(
      select +
        " WHERE image_id=? AND operator_id=? AND cleared=0 ORDER BY updated_at DESC,id LIMIT 20",
    )
    .all(imageId, userId)
    .map(decode);
}
export function readDraft(db: Db, imageId: string, userId: string, id: string) {
  requireImageMember(db, imageId, userId);
  draftId(id);
  const row = db
    .prepare(select + " WHERE id=? AND image_id=? AND operator_id=?")
    .get(id, imageId, userId);
  if (!row) return fail(404, "DRAFT_NOT_FOUND", "草稿不存在");
  return decode(row);
}
export function writeDraft(
  db: Db,
  imageId: string,
  userId: string,
  id: string,
  input: any,
) {
  draftId(id);
  const expectedVersion = version(input?.expectedVersion);
  if (
    !input ||
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision < 0 ||
    !Array.isArray(input.annotations) ||
    input.annotations.length > 100
  )
    fail(400, "INVALID_DRAFT", "草稿数据无效");
  validateSave({
    actorId: userId,
    baseRevision: input.baseRevision,
    annotations: input.baseAnnotations,
  });
  const ids = new Set<string>();
  for (const a of input.annotations) {
    if (
      !a ||
      typeof a.id !== "string" ||
      !uuid.test(a.id) ||
      ids.has(a.id) ||
      typeof a.x !== "number" ||
      typeof a.y !== "number" ||
      !Number.isFinite(a.x) ||
      !Number.isFinite(a.y) ||
      a.x < 0 ||
      a.x > 1 ||
      a.y < 0 ||
      a.y > 1 ||
      typeof a.content !== "string" ||
      [...a.content].length > 5000
    )
      fail(400, "INVALID_DRAFT", "草稿标记须有有效坐标，说明不能超过5000字符");
    ids.add(a.id);
  }
  if (
    input.selectedId !== null &&
    (typeof input.selectedId !== "string" ||
      (!ids.has(input.selectedId) && input.selectedId !== ""))
  )
    fail(400, "INVALID_DRAFT", "草稿选中标记无效");
  const strip = (a: Annotation, i: number) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    content: a.content,
    sortOrder: i,
  });
  return db.transaction(() => {
    requireImageMember(db, imageId, userId);
    const existing = db
      .prepare(
        "SELECT image_id,operator_id,version,cleared FROM review_drafts WHERE id=?",
      )
      .get(id) as any;
    if (
      existing &&
      (existing.image_id !== imageId ||
        existing.operator_id !== userId ||
        existing.version !== expectedVersion ||
        existing.cleared)
    )
      fail(409, "DRAFT_CONFLICT", "草稿备份版本已变化，请另存当前草稿");
    if (!existing && expectedVersion !== 0)
      fail(409, "DRAFT_CONFLICT", "草稿备份版本已变化");
    const time = new Date().toISOString();
    db.prepare(
      `INSERT INTO review_drafts(id,image_id,operator_id,base_revision,base_annotations,annotations,selected_id,version,cleared,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?)
    ON CONFLICT(id) DO UPDATE SET base_revision=excluded.base_revision,base_annotations=excluded.base_annotations,annotations=excluded.annotations,selected_id=excluded.selected_id,version=excluded.version,updated_at=excluded.updated_at`,
    ).run(
      id,
      imageId,
      userId,
      input.baseRevision,
      JSON.stringify(input.baseAnnotations.map(strip)),
      JSON.stringify(input.annotations.map(strip)),
      input.selectedId || null,
      expectedVersion + 1,
      time,
    );
    return readDraft(db, imageId, userId, id);
  })();
}
export function clearDraft(
  db: Db,
  imageId: string,
  userId: string,
  id: string,
  inputVersion: unknown,
) {
  draftId(id);
  const expectedVersion = version(inputVersion);
  return db.transaction(() => {
    requireImageMember(db, imageId, userId);
    const row = db
      .prepare(
        "SELECT image_id,operator_id,version,cleared FROM review_drafts WHERE id=?",
      )
      .get(id) as any;
    if (row && (row.image_id !== imageId || row.operator_id !== userId))
      fail(404, "DRAFT_NOT_FOUND", "草稿不存在");
    if (row?.cleared) return { ok: true };
    if (row && row.version !== expectedVersion)
      fail(409, "DRAFT_CONFLICT", "其他窗口更新了这份草稿，请重新检查");
    if (!row && expectedVersion !== 0)
      fail(409, "DRAFT_CONFLICT", "草稿版本已变化");
    // Keep a version tombstone so a delayed PUT cannot recreate cleared content.
    db.prepare(
      `INSERT INTO review_drafts(id,image_id,operator_id,base_revision,base_annotations,annotations,selected_id,version,cleared,updated_at) VALUES(?,?,?,0,'[]','[]',NULL,?,1,?)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,cleared=1,base_annotations='[]',annotations='[]',selected_id=NULL,updated_at=excluded.updated_at`,
    ).run(id, imageId, userId, expectedVersion + 1, new Date().toISOString());
    return { ok: true };
  })();
}
