import { describe, it, expect, vi, afterEach } from "vitest";
import { useReview } from "../apps/web/src/useReview";
import type { Review } from "../packages/shared/src/contracts";
const initial: Review = {
  image: { id: "i", title: "图", width: 900, height: 1200, revision: 0 },
  annotations: [],
  savedAt: "initial",
};
function mockFetch(
  replies: ((url: string, options?: RequestInit) => Promise<Response>)[],
) {
  const mock = vi.fn(async (url: string, options?: RequestInit) => {
    const next = replies.shift();
    if (!next) throw new Error("Unexpected request");
    return next(url, options);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const json =
  (data: any, status = 200) =>
  async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const r = useReview();
  r.current.value = JSON.parse(JSON.stringify(initial));
  r.add(0.3, 0.6);
  r.draft.value[0].content = "原说明";
  r.edit();
  return r;
}
describe("草稿保存状态机", () => {
  it("500保留草稿，恢复后重试", async () => {
    const r = await setup();
    mockFetch([json({ message: "模拟失败" }, 500)]);
    expect(await r.save()).toBe(false);
    expect(r.status.value).toBe("error");
    expect(r.draft.value[0].content).toBe("原说明");
    mockFetch([
      async (_url, options) => {
        const data = JSON.parse(options!.body as string);
        return new Response(
          JSON.stringify({
            ...initial,
            image: { ...initial.image, revision: 1 },
            annotations: data.annotations,
          }),
        );
      },
    ]);
    expect(await r.save()).toBe(true);
    expect(r.dirty.value).toBe(false);
  });
  it("网络中断+查询失败冻结编辑与切换，查询仍旧版本后允许重试", async () => {
    const r = await setup();
    mockFetch([
      async () => {
        throw new TypeError("network");
      },
      async () => {
        throw new TypeError("offline");
      },
    ]);
    await r.save();
    expect(r.status.value).toBe("unconfirmed");
    expect(r.locked.value).toBe(true);
    await r.switchTo("actor", "operator-2");
    expect(r.actor.value).toBe("operator-1");
    mockFetch([json(initial)]);
    await r.reconcile();
    expect(r.status.value).toBe("error");
    expect(r.draft.value[0].content).toBe("原说明");
  });
  it("保存后切人：未确认时保留原操作人，冻结提交快照", async () => {
    const r = await setup();
    await r.switchTo("actor", "operator-2");
    let sent: any;
    mockFetch([
      async (_url, options) => {
        sent = JSON.parse(options!.body as string);
        throw new TypeError("lost");
      },
      async () => {
        throw new TypeError("offline");
      },
    ]);
    await r.resolveSwitch("save");
    expect(sent.actorId).toBe("operator-1");
    expect(r.actor.value).toBe("operator-1");
    expect(r.status.value).toBe("unconfirmed");
    expect(r.draft.value[0].content).toBe("原说明");
  });
  it("冲突不自动升级版本或重发", async () => {
    const r = await setup();
    const fetch = mockFetch([
      async () => {
        throw new TypeError("lost");
      },
      json({ ...initial, image: { ...initial.image, revision: 2 } }),
    ]);
    await r.save();
    expect(r.status.value).toBe("conflict");
    expect(r.current.value!.image.revision).toBe(0);
    expect(await r.save()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
