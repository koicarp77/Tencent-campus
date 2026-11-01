import { randomUUID } from "node:crypto";
import type {
  Annotation,
  MergeInfo,
} from "../../../packages/shared/src/contracts.js";
const same = (a: Annotation, b: Annotation) =>
  a.x === b.x && a.y === b.y && a.content.trim() === b.content.trim();
/** Three-way merge against a server-owned baseline, never a client snapshot. */
export function mergeAnnotations(
  base: Annotation[],
  latest: Annotation[],
  incoming: Annotation[],
  actorId: string,
  time: string,
  rebased: boolean,
) {
  const baseline = new Map(base.map((a) => [a.id, a]));
  const submitted = new Map(
    incoming.map((a) => [a.id, { ...a, content: a.content.trim() }]),
  );
  const current = new Map(latest.map((a) => [a.id, a]));
  const result = new Map(latest.map((a) => [a.id, { ...a }]));
  const mergeInfo: MergeInfo = { rebased, forks: [], preservedDeletions: 0 };
  const changed = (a: Annotation, old?: Annotation): Annotation => ({
    id: a.id,
    x: a.x,
    y: a.y,
    content: a.content.trim(),
    sortOrder: 0,
    createdBy: old?.createdBy || actorId,
    createdAt: old?.createdAt || time,
    updatedBy: actorId,
    updatedAt: time,
  });
  function fork(a: Annotation) {
    const id = randomUUID();
    result.set(id, changed({ ...a, id }));
    mergeInfo.forks.push({ originalId: a.id, newId: id });
  }
  for (const old of base) {
    const mine = submitted.get(old.id),
      theirs = current.get(old.id);
    if (!mine) {
      if (theirs && same(theirs, old)) result.delete(old.id);
      else if (theirs) mergeInfo.preservedDeletions++;
    } else if (!same(mine, old)) {
      if (!theirs) fork(mine);
      else if (same(theirs, old)) result.set(mine.id, changed(mine, theirs));
      else if (!same(mine, theirs)) fork(mine);
    }
  }
  for (const mine of submitted.values()) {
    if (baseline.has(mine.id)) continue;
    const theirs = current.get(mine.id);
    if (!theirs) result.set(mine.id, changed(mine));
    else if (!same(mine, theirs)) fork(mine);
  }
  const timestamp = (a: Annotation) => {
    const value = Date.parse(a.createdAt || "");
    return Number.isFinite(value) ? value : 0;
  };
  // Stable sort preserves the transaction's insertion order when timestamps tie.
  const annotations = [...result.values()]
    .sort((a, b) => timestamp(a) - timestamp(b))
    .map((a, sortOrder) => ({ ...a, sortOrder }));
  return { annotations, mergeInfo };
}
