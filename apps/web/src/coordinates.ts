export const clamp = (v: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, v));
export function point(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width,
    y = (clientY - rect.top) / rect.height;
  return Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1
    ? { x, y }
    : null;
}
export function centerAnchor(
  view: { left: number; top: number; width: number; height: number },
  image: { left: number; top: number; width: number; height: number },
) {
  return {
    x: clamp((view.left + view.width / 2 - image.left) / image.width),
    y: clamp((view.top + view.height / 2 - image.top) / image.height),
  };
}
