import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { useGroupEvents } from "../apps/web/src/useGroupEvents";
class Stream extends EventTarget {
  static instances: Stream[] = [];
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    super();
    Stream.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: any = {}) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  Stream.instances = [];
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal("EventSource", Stream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("ready与change通知补查，旧连接和销毁后的消息不再作用", () => {
  const change = vi.fn(),
    lost = vi.fn();
  const r = useGroupEvents("组ID", "账号ID", change, lost);
  r.start();
  const first = Stream.instances[0];
  expect(first.url).toContain(encodeURIComponent("账号ID"));
  first.emit("ready");
  first.emit("change", { type: "review", imageId: "i", revision: 2 });
  expect(change.mock.calls).toEqual([
    [null],
    [{ type: "review", imageId: "i", revision: 2 }],
  ]);
  window.dispatchEvent(new Event("online"));
  expect(first.closed).toBe(true);
  first.emit("change", { type: "review" });
  expect(change).toHaveBeenCalledTimes(2);
  const second = Stream.instances[1];
  r.stop();
  second.emit("ready");
  expect(second.closed).toBe(true);
  expect(change).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("断线自动重连，ready重新补查；stop清理重试任务", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/session")
              ? { user: { id: "u", name: "甲" } }
              : { id: "g" },
          ),
        ),
    ),
  );
  const change = vi.fn();
  const r = useGroupEvents("g", "u", change, vi.fn());
  r.start();
  Stream.instances[0].emit("ready");
  Stream.instances[0].onerror!();
  expect(r.connection.value).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(1500);
  expect(Stream.instances).toHaveLength(2);
  Stream.instances[1].emit("ready");
  expect(change.mock.calls).toEqual([[null], [null]]);
  Stream.instances[1].onerror!();
  r.stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(Stream.instances).toHaveLength(2);
});
it("另一标签页切换账号或群组权限丢失，停止重连并报告失效", async () => {
  const lost = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ user: { id: "other" } }))),
  );
  const r = useGroupEvents("g", "u", vi.fn(), lost);
  r.start();
  Stream.instances[0].onerror!();
  await vi.advanceTimersByTimeAsync(1500);
  expect(lost).toHaveBeenCalledOnce();
  expect(r.connection.value).toBe("denied");
  expect(Stream.instances).toHaveLength(1);
  r.stop();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/session")
              ? { user: { id: "u" } }
              : { message: "非成员" },
          ),
          { status: url.endsWith("/session") ? 200 : 403 },
        ),
    ),
  );
  const other = useGroupEvents("g", "u", vi.fn(), lost);
  other.start();
  Stream.instances[1].onerror!();
  await vi.advanceTimersByTimeAsync(1500);
  expect(lost).toHaveBeenCalledTimes(2);
  other.stop();
});
it("服务端access-lost关闭连接，断线期间的网络错误仍允许重试", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("offline");
    }),
  );
  const lost = vi.fn(),
    r = useGroupEvents("g", "u", vi.fn(), lost);
  r.start();
  Stream.instances[0].onerror!();
  await vi.advanceTimersByTimeAsync(1500);
  expect(Stream.instances).toHaveLength(2);
  Stream.instances[1].emit("access-lost");
  expect(lost).toHaveBeenCalledOnce();
  expect(Stream.instances[1].closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  r.stop();
});

it("离线事件立即关闭旧连接，重新联网重新连接并补查", () => {
  const change = vi.fn(),
    r = useGroupEvents("g", "u", change, vi.fn());
  r.start();
  Stream.instances[0].emit("ready");
  window.dispatchEvent(new Event("offline"));
  expect(r.connection.value).toBe("reconnecting");
  expect(Stream.instances[0].closed).toBe(true);
  window.dispatchEvent(new Event("online"));
  expect(Stream.instances).toHaveLength(2);
  Stream.instances[1].emit("ready");
  expect(change).toHaveBeenCalledTimes(2);
  r.stop();
});
