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
    if (url.includes("/submissions/"))
      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
      });
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
            annotations: data.added.map((a: any, sortOrder: number) => ({
              ...a,
              sortOrder,
            })),
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
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

const echoSaved =
  (base: any[] = []) =>
  async (_url: string, options?: RequestInit) => {
    const body = JSON.parse(options!.body as string);
    return new Response(
      JSON.stringify({
        ...initial,
        image: { ...initial.image, revision: body.baseRevision + 1 },
        annotations: [
          ...base
            .filter((a) => !body.deleted.includes(a.id))
            .map((a) => body.updated.find((v: any) => v.id === a.id) || a),
          ...body.added,
        ].map((a, sortOrder) => ({ ...a, sortOrder })),
        savedAt: "confirmed",
      }),
    );
  };
async function incompleteFirst() {
  const r = await setup();
  r.draft.value[0].content = "";
  r.add(0.5, 0.5);
  r.draft.value[1].content = "后续标记已填好";
  r.edit();
  return r;
}
describe("未完成标记不阻塞其他标记保存", () => {
  it("保存第二条并保留第一条空白草稿；补全后使用新版本保存两条", async () => {
    const r = await incompleteFirst();
    const firstId = r.draft.value[0].id;
    const fetch = mockFetch([echoSaved(r.current.value!.annotations)]);
    expect(await r.save()).toBe(false); // Some drafts still prevent navigation.
    expect(r.status.value).toBe("partial");
    expect(r.current.value!.annotations).toHaveLength(1);
    expect(r.current.value!.annotations[0].content).toBe("后续标记已填好");
    expect(r.draft.value).toHaveLength(2);
    expect(r.draft.value[0]).toMatchObject({ id: firstId, content: "" });
    expect(r.dirty.value).toBe(true);
    expect(r.message.value).toContain("已保存已完成");
    expect(await r.save()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // No repeated writes of the same data.
    r.draft.value[0].content = "补全第一条";
    r.edit();
    const retry = mockFetch([echoSaved(r.current.value!.annotations)]);
    expect(await r.save()).toBe(true);
    const sent = JSON.parse(retry.mock.calls[0][1]!.body as string);
    expect(sent.baseRevision).toBe(1);
    expect(sent.added.map((a: any) => a.content)).toEqual(["补全第一条"]);
    expect(r.status.value).toBe("clean");
  });
  it("已有标记说明暂时清空时保留服务端旧文案，其他标记照常保存", async () => {
    const r = await setup();
    mockFetch([echoSaved(r.current.value!.annotations)]);
    await r.save();
    const old = JSON.parse(JSON.stringify(r.current.value!.annotations[0]));
    r.draft.value[0].content = "";
    r.add(0.6, 0.6);
    r.draft.value[1].content = "新标记";
    r.edit();
    mockFetch([echoSaved(r.current.value!.annotations)]);
    await r.save();
    expect(r.current.value!.annotations[0]).toEqual(old);
    expect(r.current.value!.annotations[1].content).toBe("新标记");
    expect(r.draft.value[0].content).toBe("");
  });
  it("部分保存的响应丢失后核对成功也保留未完成草稿", async () => {
    const r = await incompleteFirst();
    const payload = JSON.parse(
      JSON.stringify(r.draft.value.filter((a) => a.content)),
    );
    mockFetch([
      async () => {
        throw new TypeError("lost");
      },
      json({
        ...initial,
        image: { ...initial.image, revision: 1 },
        annotations: payload,
      }),
    ]);
    expect(await r.save()).toBe(false);
    expect(r.status.value).toBe("partial");
    expect(r.message.value).toContain("已核对");
    expect(r.draft.value).toHaveLength(2);
    expect(r.draft.value[0].content).toBe("");
  });
  it("部分保存失败不丢任何草稿，超长说明同样不阻塞有效标记", async () => {
    const r = await incompleteFirst();
    r.draft.value[0].content = "字".repeat(501);
    r.edit();
    mockFetch([json({ message: "保存失败" }, 500)]);
    await r.save();
    expect(r.status.value).toBe("error");
    expect(r.draft.value).toHaveLength(2);
    mockFetch([echoSaved(r.current.value!.annotations)]);
    await r.save();
    expect(r.current.value!.annotations).toHaveLength(1);
    expect(r.draft.value[0].content.length).toBe(501);
    expect(r.status.value).toBe("partial");
  });
  it("保存后切人时有未完成草稿则仍留在原操作人，不丢草稿", async () => {
    const r = await incompleteFirst();
    await r.switchTo("actor", "operator-2");
    mockFetch([echoSaved(r.current.value!.annotations)]);
    await r.resolveSwitch("save");
    expect(r.actor.value).toBe("operator-1");
    expect(r.current.value!.annotations).toHaveLength(1);
    expect(r.draft.value).toHaveLength(2);
    expect(r.pending.value).toBeNull();
  });
});

it("合并响应保留双方及未完成草稿，重试沿用提交ID", async () => {
  const r = await setup();
  const pending = {
    id: crypto.randomUUID(),
    x: 0.1,
    y: 0.1,
    content: "",
    sortOrder: 1,
  };
  r.draft.value.push(pending);
  let firstId = "";
  mockFetch([
    async (_url, options) => {
      firstId = JSON.parse(options!.body as string).submissionId;
      return new Response(JSON.stringify({ message: "失败" }), { status: 500 });
    },
  ]);
  await r.save();
  mockFetch([
    async (_url, options) => {
      const input = JSON.parse(options!.body as string);
      expect(input.submissionId).toBe(firstId);
      return new Response(
        JSON.stringify({
          ...initial,
          image: { ...initial.image, revision: 2 },
          annotations: [
            { ...input.added[0], content: "另一人的内容" },
            { ...input.added[0], id: crypto.randomUUID() },
          ],
          mergeInfo: { rebased: true, forks: [], preservedDeletions: 0 },
        }),
      );
    },
  ]);
  expect(await r.save()).toBe(false);
  expect(r.status.value).toBe("partial");
  expect(r.draft.value.map((a) => a.content)).toContain("另一人的内容");
  expect(r.draft.value.map((a) => a.content)).toContain("原说明");
  expect(r.draft.value.find((a) => a.id === pending.id)?.content).toBe("");
});
it("响应丢失后用提交收据确认合并结果，不误报冲突", async () => {
  const r = await setup();
  let receipt: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/annotations")) {
        const input = JSON.parse(options!.body as string);
        receipt = {
          submissionId: input.submissionId,
          review: {
            ...initial,
            image: { ...initial.image, revision: 2 },
            annotations: [
              ...input.added,
              {
                ...input.added[0],
                id: crypto.randomUUID(),
                content: "他人内容",
              },
            ],
            mergeInfo: { rebased: true, forks: [], preservedDeletions: 0 },
          },
        };
        throw new TypeError("lost");
      }
      return new Response(
        JSON.stringify(
          url.includes("/submissions/") ? receipt : receipt.review,
        ),
      );
    }),
  );
  expect(await r.save()).toBe(true);
  expect(r.status.value).toBe("clean");
  expect(r.draft.value).toHaveLength(2);
  expect(r.message.value).toContain("合并");
});

it("100个标记仅提交修改的1个，删除只发ID，未完成内容不被误删", async () => {
  const r = await setup();
  const baseline = Array.from({ length: 100 }, (_, i) => ({
    id: crypto.randomUUID(),
    x: 0.2,
    y: 0.3,
    content: `第${i + 1}条`,
    sortOrder: i,
  }));
  r.current.value = {
    ...initial,
    image: { ...initial.image, revision: 1 },
    annotations: baseline,
  };
  r.draft.value = structuredClone(baseline);
  r.draft.value[7].content = "只改第8条";
  r.draft.value[9].content = "";
  r.remove(baseline[10].id);
  let sent: any;
  mockFetch([
    async (url, options) => {
      expect(options!.method).toBe("PATCH");
      sent = JSON.parse(options!.body as string);
      expect(sent.annotations).toBeUndefined();
      expect(sent.added).toEqual([]);
      expect(sent.updated).toEqual([
        { id: baseline[7].id, x: 0.2, y: 0.3, content: "只改第8条" },
      ]);
      expect(sent.deleted).toEqual([baseline[10].id]);
      return echoSaved(baseline)(url, options);
    },
  ]);
  expect(await r.save()).toBe(false);
  expect(r.status.value).toBe("partial");
  expect(r.current.value!.annotations).toHaveLength(99);
  expect(r.draft.value.find((a) => a.id === baseline[9].id)?.content).toBe("");
});

it.each([false, true])(
  "群组被删后延迟到达的成功响应不复活已删资源，未完成项仍保留（含未完成项=%s）",
  async (partial) => {
    const r = await setup();
    if (partial) {
      r.draft.value.push({
        id: crypto.randomUUID(),
        x: 0.2,
        y: 0.2,
        content: "",
        sortOrder: 1,
      });
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockFetch([
      async (url, options) => {
        await gate;
        return echoSaved()(url, options);
      },
    ]);
    const saved = r.save();
    expect(r.status.value).toBe("saving");
    r.remoteDeleted.value = "group";
    release();
    await saved;
    expect(r.unavailable.value).toBe(true);
    if (partial) {
      expect(r.status.value).toBe("partial");
      expect(r.dirty.value).toBe(true);
      expect(r.draft.value.some((a) => a.content === "")).toBe(true);
    } else {
      expect(r.current.value).toBeNull();
      expect(r.draft.value).toEqual([]);
    }
    r.stopRealtime();
  },
);
