export interface Account {
  id: string;
  name: string;
}
export interface GroupInfo {
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: string;
  memberCount: number;
  joined: boolean;
}
export interface Annotation {
  id: string;
  x: number;
  y: number;
  content: string;
  sortOrder: number;
  createdByName?: string;
  updatedByName?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface ImageInfo {
  createdBy?: string;
  groupId?: string;
  id: string;
  title: string;
  width: number;
  height: number;
  revision: number;
}
export interface MergeInfo {
  rebased: boolean;
  forks: { originalId: string; newId: string }[];
  preservedDeletions: number;
}
export interface Review {
  mergeInfo?: MergeInfo;
  image: ImageInfo;
  annotations: Annotation[];
  savedAt: string;
}
export interface SaveBody {
  submissionId?: string;
  actorId: string;
  baseRevision: number;
  annotations: Annotation[];
}
export const contentLength = (s: string) => [...s.trim()].length;
export function business(a: Annotation[]) {
  return JSON.stringify(
    a.map((v, i) => ({
      id: v.id,
      x: v.x,
      y: v.y,
      content: v.content.trim(),
      sortOrder: i,
    })),
  );
}

export interface DraftBackup {
  id: string;
  baseRevision: number;
  baseAnnotations: Annotation[];
  annotations: Annotation[];
  selectedId: string | null;
  version: number;
  cleared: boolean;
  updatedAt: string;
}

export interface SavedSubmission {
  submissionId: string;
  review: Review;
}

export type AnnotationChange = Pick<Annotation, "id" | "x" | "y" | "content">;
export interface PatchBody {
  submissionId: string;
  actorId: string;
  baseRevision: number;
  added: AnnotationChange[];
  updated: AnnotationChange[];
  deleted: string[];
}
export function annotationChanges(base: Annotation[], next: Annotation[]) {
  const old = new Map(base.map((a) => [a.id, a]));
  const ids = new Set(next.map((a) => a.id));
  const added: AnnotationChange[] = [],
    updated: AnnotationChange[] = [];
  for (const a of next) {
    const previous = old.get(a.id);
    const value = { id: a.id, x: a.x, y: a.y, content: a.content.trim() };
    if (!previous) added.push(value);
    else if (
      previous.x !== a.x ||
      previous.y !== a.y ||
      previous.content.trim() !== value.content
    )
      updated.push(value);
  }
  return {
    added,
    updated,
    deleted: base.filter((a) => !ids.has(a.id)).map((a) => a.id),
  };
}
