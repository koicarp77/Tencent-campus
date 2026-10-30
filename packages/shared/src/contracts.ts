export interface Annotation {
  id: string;
  x: number;
  y: number;
  content: string;
  sortOrder: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface ImageInfo {
  id: string;
  title: string;
  width: number;
  height: number;
  revision: number;
}
export interface Review {
  image: ImageInfo;
  annotations: Annotation[];
  savedAt: string;
}
export interface SaveBody {
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
