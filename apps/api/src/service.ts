import { createHash } from "node:crypto";
import { mergeAnnotations } from "./merge.js";
import type { Db } from "./database.js";
import {
  business,
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
  "SELECT id,title,width,height,revision,created_by AS createdBy,updated_at AS savedAt,(SELECT group_id FROM image_groups WHERE image_id=images.id) AS groupId FROM images";
export function listImages(db: Db, groupId: string) {
  return db
    .prepare(
      imageSelect +
        " WHERE id IN (SELECT image_id FROM image_groups WHERE group_id=?) ORDER BY created_at,id",
    )
    .all(groupId);
}
export function review(db: Db, id: string): Review {
  const row = db.prepare(imageSelect + " WHERE id=?").get(id) as any;
  if (!row) return fail(404, "IMAGE_NOT_FOUND", "图片不存在");
  const { savedAt, ...image } = row;
  const annotations = db
    .prepare(
      "SELECT id,x,y,content,sort_order AS sortOrder,created_by AS createdBy,updated_by AS updatedBy,created_at AS createdAt,updated_at AS updatedAt,(SELECT name FROM operators WHERE id=created_by) AS createdByName,(SELECT name FROM operators WHERE id=updated_by) AS updatedByName FROM annotations WHERE image_id=? ORDER BY sort_order",
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
export function savedSubmission(
  db: Db,
  imageId: string,
  submissionId: string,
  actorId: string,
) {
  const row = db
    .prepare(
      "SELECT result_json FROM review_submissions WHERE image_id=? AND submission_id=? AND operator_id=?",
    )
    .get(imageId, submissionId, actorId) as any;
  if (!row) return fail(404, "SUBMISSION_NOT_FOUND", "本次提交尚无成功记录");
  return { submissionId, review: JSON.parse(row.result_json) as Review };
}
export function saveReview(
  db: Db,
  id: string,
  input: unknown,
  afterWrite?: () => void,
): Review {
  validateSave(input);
  actor(db, input.actorId);
  if (
    input.submissionId !== undefined &&
    (typeof input.submissionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.submissionId,
      ))
  )
    fail(400, "INVALID_SUBMISSION", "提交ID无效");
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        actorId: input.actorId,
        baseRevision: input.baseRevision,
        annotations: business(input.annotations),
      }),
    )
    .digest("hex");
  return db.transaction(() => {
    const before = review(db, id);
    if (input.submissionId) {
      const old = db
        .prepare(
          "SELECT operator_id,request_hash,result_json FROM review_submissions WHERE image_id=? AND submission_id=?",
        )
        .get(id, input.submissionId) as any;
      if (old) {
        if (old.operator_id !== input.actorId || old.request_hash !== hash)
          fail(409, "SUBMISSION_REUSED", "提交ID已被其他内容使用");
        return JSON.parse(old.result_json) as Review;
      }
    }
    for (const a of input.annotations) {
      const owner = db
        .prepare("SELECT image_id FROM annotations WHERE id=?")
        .get(a.id) as any;
      if (owner && owner.image_id !== id)
        fail(400, "WRONG_IMAGE", "标记属于其他图片");
    }
    db.prepare("INSERT OR IGNORE INTO review_versions VALUES(?,?,?)").run(
      id,
      before.image.revision,
      JSON.stringify(before.annotations),
    );
    const baseline = db
      .prepare(
        "SELECT annotations FROM review_versions WHERE image_id=? AND revision=?",
      )
      .get(id, input.baseRevision) as any;
    if (!baseline)
      fail(
        409,
        "BASELINE_MISSING",
        "旧版本基准不可用，请先复制本地说明并加载最新版本",
      );
    const previousTime = Date.parse(before.savedAt);
    const time = new Date(
      Math.max(
        Date.now(),
        Number.isFinite(previousTime) ? previousTime + 1 : 0,
      ),
    ).toISOString();
    const { annotations, mergeInfo } = mergeAnnotations(
      JSON.parse(baseline.annotations),
      before.annotations,
      input.annotations,
      input.actorId,
      time,
      input.baseRevision !== before.image.revision,
    );
    if (annotations.length > 100)
      fail(
        409,
        "MERGE_LIMIT",
        "保留双方修改后超过100个标记，本次未写入。请先复制草稿并整理标记后重试",
      );
    const updated = db
      .prepare(
        "UPDATE images SET revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      )
      .run(time, id, before.image.revision);
    if (!updated.changes)
      fail(409, "REVISION_CONFLICT", "合并期间版本变化，草稿已保留，请重试");
    const oldById = new Map(before.annotations.map((a) => [a.id, a]));
    const nextIds = new Set(annotations.map((a) => a.id));
    const remove = db.prepare(
      "DELETE FROM annotations WHERE image_id=? AND id=?",
    );
    for (const old of before.annotations)
      if (!nextIds.has(old.id)) {
        remove.run(id, old.id);
        afterWrite?.();
      }
    const insert = db.prepare(
      "INSERT INTO annotations (id,image_id,x,y,content,sort_order,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    const update = db.prepare(
      "UPDATE annotations SET x=?,y=?,content=?,sort_order=?,updated_by=?,updated_at=? WHERE image_id=? AND id=?",
    );
    for (const a of annotations) {
      const old = oldById.get(a.id);
      if (!old)
        insert.run(
          a.id,
          id,
          a.x,
          a.y,
          a.content,
          a.sortOrder,
          a.createdBy,
          a.updatedBy,
          a.createdAt,
          a.updatedAt,
        );
      else if (
        old.x !== a.x ||
        old.y !== a.y ||
        old.content !== a.content ||
        old.sortOrder !== a.sortOrder ||
        old.updatedAt !== a.updatedAt ||
        old.updatedBy !== a.updatedBy
      )
        update.run(
          a.x,
          a.y,
          a.content,
          a.sortOrder,
          a.updatedBy,
          a.updatedAt,
          id,
          a.id,
        );
      else continue;
      afterWrite?.();
    }
    const result = review(db, id);
    result.mergeInfo = mergeInfo;
    db.prepare("INSERT INTO review_versions VALUES(?,?,?)").run(
      id,
      result.image.revision,
      JSON.stringify(result.annotations),
    );
    if (input.submissionId)
      db.prepare("INSERT INTO review_submissions VALUES(?,?,?,?,?)").run(
        id,
        input.submissionId,
        input.actorId,
        hash,
        JSON.stringify(result),
      );
    return result;
  })();
}

/** Apply only explicit operations to the trusted baseline, then use the shared merge transaction. */
export function patchReview(
  db: Db,
  id: string,
  input: any,
  afterWrite?: () => void,
): Review {
  if (
    !input ||
    !Array.isArray(input.added) ||
    !Array.isArray(input.updated) ||
    !Array.isArray(input.deleted) ||
    input.added.length + input.updated.length + input.deleted.length > 200 ||
    typeof input.submissionId !== "string" ||
    input.annotations !== undefined
  )
    fail(400, "INVALID_PATCH", "增量请求须包含新增、修改、删除列表及提交ID");
  validateSave({ ...input, annotations: [...input.added, ...input.updated] });
  actor(db, input.actorId);
  const ids = new Set([...input.added, ...input.updated].map((a: any) => a.id));
  for (const id of input.deleted) {
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      ) ||
      ids.has(id)
    )
      fail(400, "INVALID_PATCH", "增量操作ID无效或重复");
    ids.add(id);
  }
  if (ids.size === 0) fail(400, "EMPTY_PATCH", "没有待保存的修改");
  return db.transaction(() => {
    const current = review(db, id);
    db.prepare("INSERT OR IGNORE INTO review_versions VALUES(?,?,?)").run(
      id,
      current.image.revision,
      JSON.stringify(current.annotations),
    );
    const row = db
      .prepare(
        "SELECT annotations FROM review_versions WHERE image_id=? AND revision=?",
      )
      .get(id, input.baseRevision) as any;
    if (!row)
      fail(
        409,
        "BASELINE_MISSING",
        "旧版本基准不可用，请先复制本地说明并加载最新版本",
      );
    const base: Annotation[] = JSON.parse(row.annotations);
    const baseline = new Set(base.map((a) => a.id));
    if (
      input.added.some((a: any) => baseline.has(a.id)) ||
      input.updated.some((a: any) => !baseline.has(a.id)) ||
      input.deleted.some((id: string) => !baseline.has(id))
    )
      fail(400, "INVALID_PATCH", "新增、修改或删除操作与基准版本不一致");
    const removed = new Set(input.deleted);
    const updates = new Map<string, Annotation>(
      input.updated.map((a: Annotation) => [a.id, a]),
    );
    const next = [
      ...base
        .filter((a) => !removed.has(a.id))
        .map((a) => updates.get(a.id) || a),
      ...input.added,
    ];
    return saveReview(
      db,
      id,
      {
        actorId: input.actorId,
        submissionId: input.submissionId,
        baseRevision: input.baseRevision,
        annotations: next,
      },
      afterWrite,
    );
  })();
}
