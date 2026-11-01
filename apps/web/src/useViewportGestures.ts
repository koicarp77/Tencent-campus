import { nextTick, type Ref } from "vue";
import { clamp } from "./coordinates";

type GestureEvent = Event & {
  scale?: number;
  clientX?: number;
  clientY?: number;
};
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

/** Chrome/Edge pinch arrives as ctrl+wheel; Safari uses GestureEvent. */
export function useViewportGestures(
  viewport: Ref<HTMLElement | undefined>,
  plane: Ref<HTMLElement | undefined>,
  getScale: () => number,
  setScale: (scale: number) => void,
  ready: () => boolean,
) {
  let frame = 0;
  let pending: { scale: number; x: number; y: number } | null = null;
  let gestureActive = false;
  let gestureStartScale = 1;
  let attached: HTMLElement | undefined;

  function cancel() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    gestureActive = false;
  }

  async function apply(scale: number, x: number, y: number) {
    const v = viewport.value,
      p = plane.value;
    if (!v || !p || !ready()) return;
    const old = p.getBoundingClientRect();
    if (!old.width || !old.height) return;
    const anchor = {
      x: clamp((x - old.left) / old.width),
      y: clamp((y - old.top) / old.height),
    };
    setScale(scale);
    await nextTick();
    // A picture switch while awaiting layout must not scroll the new picture.
    if (plane.value !== p) return;
    const rect = p.getBoundingClientRect();
    v.scrollLeft = clamp(
      v.scrollLeft + rect.left + anchor.x * rect.width - x,
      0,
      v.scrollWidth - v.clientWidth,
    );
    v.scrollTop = clamp(
      v.scrollTop + rect.top + anchor.y * rect.height - y,
      0,
      v.scrollHeight - v.clientHeight,
    );
  }

  function schedule(scale: number, x: number, y: number) {
    pending = { scale: clamp(scale, MIN_SCALE, MAX_SCALE), x, y };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const value = pending;
      pending = null;
      if (value) void apply(value.scale, value.x, value.y);
    });
  }

  function wheel(event: WheelEvent) {
    if (!ready() || !plane.value || gestureActive || !event.deltaY) return;
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? (viewport.value?.clientHeight ?? 600)
          : 1;
    // Plain wheel and two-finger panning keep the browser's native scrolling.
    // Chromium pinch uses ctrlKey; Shift explicitly opts a mouse wheel into zoom.
    if (!event.shiftKey && !event.ctrlKey) return;
    event.preventDefault();
    const delta = clamp(event.deltaY * unit, -240, 240);
    const sensitivity = event.ctrlKey ? 0.01 : 0.002;
    schedule(
      (pending?.scale ?? getScale()) * Math.exp(-delta * sensitivity),
      event.clientX,
      event.clientY,
    );
  }

  function gesturePoint(event: GestureEvent) {
    const v = viewport.value!;
    const rect = v.getBoundingClientRect();
    return {
      x:
        event.clientX !== undefined &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right
          ? event.clientX
          : rect.left + v.clientWidth / 2,
      y:
        event.clientY !== undefined &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
          ? event.clientY
          : rect.top + v.clientHeight / 2,
    };
  }
  function gestureStart(event: Event) {
    if (!ready() || !plane.value) return;
    event.preventDefault();
    cancel();
    gestureActive = true;
    gestureStartScale = getScale();
  }
  function gestureChange(event: Event) {
    if (!gestureActive || !ready()) return;
    event.preventDefault();
    const gesture = event as GestureEvent;
    if (!Number.isFinite(gesture.scale) || gesture.scale! <= 0) return;
    const { x, y } = gesturePoint(gesture);
    schedule(gestureStartScale * gesture.scale!, x, y);
  }
  function gestureEnd(event: Event) {
    if (gestureActive) event.preventDefault();
    gestureActive = false;
  }

  function attach() {
    attached = viewport.value;
    attached?.addEventListener("wheel", wheel, { passive: false });
    attached?.addEventListener("gesturestart", gestureStart, {
      passive: false,
    });
    attached?.addEventListener("gesturechange", gestureChange, {
      passive: false,
    });
    attached?.addEventListener("gestureend", gestureEnd, { passive: false });
  }
  function dispose() {
    cancel();
    attached?.removeEventListener("wheel", wheel);
    attached?.removeEventListener("gesturestart", gestureStart);
    attached?.removeEventListener("gesturechange", gestureChange);
    attached?.removeEventListener("gestureend", gestureEnd);
  }
  return { attach, dispose, cancel };
}
