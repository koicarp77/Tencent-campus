import type { Db } from "./database.js";
import {
  contentLength,
  type Annotation,
  type Review,
  type SaveBody,
} from "../../../packages/shared/src/contracts.js";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
export function actor(db: Db, id: unknown) {
  if (
    typeof id !== "string" ||
    !db.prepare("SELECT id FROM operators WHERE id=?").get(id)
  )
    fail(400, "INVALID_ACTOR", "请选择有效的操作人");
}
const imageSelect =
  "SELECT id,title,width,height,revision,updated_at AS savedAt FROM images";
export function listImages(db: Db) {
  return db.prepare(imageSelect + " ORDER BY created_at,id").all();
}
export function review(db: Db, id: string): Review {
  const row = db.prepare(imageSelect + " WHERE id=?").get(id) as any;
  if (!row) return fail(404, "IMAGE_NOT_FOUND", "图片不存在");
  const { savedAt, ...image } = row;
  const annotations = db
    .prepare(
      "SELECT id,x,y,content,sort_order AS sortOrder,created_by AS createdBy,updated_by AS updatedBy,created_at AS createdAt,updated_at AS updatedAt FROM annotations WHERE image_id=? ORDER BY sort_order",
    )
    .all(id) as Annotation[];
  return { image, annotations, savedAt };
}
export function validateSave(input: any): asserts input is SaveBody {
  if (
    !input ||
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision < 0 ||
    !Array.isArray(input.annotations) ||
    input.annotations.length > 100
  )
    fail(400, "INVALID_INPUT", "版本号无效，或标记数量超过100条");
  const ids = new Set();
  for (const [i, a] of input.annotations.entries()) {
    if (
      !a ||
      typeof a.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        a.id,
      ) ||
      ids.has(a.id)
    )
      fail(400, "INVALID_ID", `标记 ${i + 1} 的ID无效或重复`);
    ids.add(a.id);
    if (
      typeof a.x !== "number" ||
      typeof a.y !== "number" ||
      !Number.isFinite(a.x) ||
      !Number.isFinite(a.y) ||
      a.x < 0 ||
      a.x > 1 ||
      a.y < 0 ||
      a.y > 1
    )
      fail(400, "INVALID_COORDINATES", `标记 ${i + 1} 的坐标无效`);
    if (
      typeof a.content !== "string" ||
      contentLength(a.content) < 1 ||
      contentLength(a.content) > 500
    )
      fail(400, "INVALID_CONTENT", `标记 ${i + 1} 的说明须为1—500个字符`);
  }
}
export function saveReview(
  db: Db,
  id: string,
  input: unknown,
  afterWrite?: () => void,
): Review {
  validateSave(input);
  actor(db, input.actorId);
  return db.transaction(() => {
    const before = review(db, id);
    const time = new Date().toISOString();
    for (const a of input.annotations) {
      const owner = db
        .prepare("SELECT image_id FROM annotations WHERE id=?")
        .get(a.id) as any;
      if (owner && owner.image_id !== id)
        fail(400, "WRONG_IMAGE", "标记属于其他图片");
    }
    const updated = db
      .prepare(
        "UPDATE images SET revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      )
      .run(time, id, input.baseRevision);
    if (!updated.changes)
      fail(409, "REVISION_CONFLICT", "这张图已被其他人修改，本地草稿已保留");
    const old = new Map(before.annotations.map((a) => [a.id, a]));
    db.prepare("DELETE FROM annotations WHERE image_id=?").run(id);
    const insert = db.prepare(
      "INSERT INTO annotations (id,image_id,x,y,content,sort_order,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    input.annotations.forEach((a, i) => {
      const prev = old.get(a.id);
      const content = a.content.trim();
      const changed =
        !prev || prev.x !== a.x || prev.y !== a.y || prev.content !== content;
      insert.run(
        a.id,
        id,
        a.x,
        a.y,
        content,
        i,
        prev?.createdBy || input.actorId,
        changed ? input.actorId : prev!.updatedBy,
        prev?.createdAt || time,
        changed ? time : prev!.updatedAt,
      );
      afterWrite?.();
    });
    return review(db, id);
  })();
}
