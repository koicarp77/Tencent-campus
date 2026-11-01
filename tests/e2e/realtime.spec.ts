import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

const imageId = "demo-detail";
const annotationUrl = `/api/images/${imageId}/annotations`;
const marker = (content = "原说明") => ({
  id: randomUUID(),
  x: 0.25,
  y: 0.3,
  content,
  sortOrder: 0,
});

test.beforeEach(() =>
  execFileSync(process.execPath, ["--import", "tsx", "scripts/reset-test.ts"], {
    env: process.env,
  }),
);

async function pair(browser: Browser, baseURL?: string) {
  const contexts = await Promise.all(
    ["小林", "小周"].map(async (name) => {
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 1440, height: 1000 },
      });
      expect(
        (
          await context.request.post("/api/auth/login", { data: { name } })
        ).status(),
      ).toBe(200);
      return context;
    }),
  );
  return {
    contexts,
    pages: await Promise.all(contexts.map((c) => c.newPage())),
    close: () => Promise.all(contexts.map((c) => c.close())),
  };
}
async function open(page: Page, group = "default-group", image = imageId) {
  await page.goto(`/?group=${group}&image=${image}`);
  await expect(page.getByTestId("realtime-status")).toHaveText(
    "实时同步已连接",
  );
  await expect(
    page.getByRole("region", { name: "图片审核工作区" }),
  ).toBeVisible();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
}
async function read(context: BrowserContext) {
  return context.request
    .get(`/api/images/${imageId}/review`)
    .then((r) => r.json());
}
async function seed(context: BrowserContext) {
  const a = marker();
  expect(
    (
      await context.request.put(annotationUrl, {
        data: { baseRevision: 0, annotations: [a] },
      })
    ).status(),
  ).toBe(200);
  return a;
}
async function editOnly(page: Page, text: string) {
  await page.locator(".annotation-card").first().click();
  await page.getByLabel(/问题说明/).fill(text);
}

test("实时推送：干净页面无需刷新看到其他账号新增、修改和删除标记", async ({
  browser,
  baseURL,
}) => {
  const p = await pair(browser, baseURL);
  try {
    const [a, b] = p.pages;
    await Promise.all(p.pages.map((page) => open(page)));
    let documentLoads = 0;
    b.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === b.mainFrame())
        documentLoads++;
    });
    await a.getByTestId("image-plane").click({ position: { x: 210, y: 200 } });
    await a.getByLabel(/问题说明/).fill("A新增的标记");
    await save(a);
    await expect(b.locator(".annotation-card")).toHaveCount(1);
    await expect(b.locator(".annotation-card")).toContainText("A新增的标记");
    await editOnly(a, "A修改后的说明");
    await save(a);
    await expect(b.locator(".annotation-card")).toContainText("A修改后的说明");
    await a.locator(".annotation-card").click();
    await a.getByRole("button", { name: "删除标记", exact: true }).click();
    await save(a);
    await expect(b.locator(".annotation-card")).toHaveCount(0);
    expect(documentLoads).toBe(0);
  } finally {
    await p.close();
  }
});

test("实时推送：B编辑同标记时保留输入和旧基准，保存后双方自动看到两份内容", async ({
  browser,
  baseURL,
}) => {
  const p = await pair(browser, baseURL);
  try {
    const m = await seed(p.contexts[0]);
    await Promise.all(p.pages.map((page) => open(page)));
    const [a, b] = p.pages;
    await editOnly(b, "B仍在输入的价格说明");
    await editOnly(a, "A刚保存的日期说明");
    await save(a);
    await expect(b.getByLabel(/问题说明/)).toHaveValue("B仍在输入的价格说明");
    await expect(b.getByTestId("remote-updates")).toContainText(
      "A刚保存的日期说明",
    );
    await b.screenshot({
      path: "docs/verification/realtime-editing.png",
      fullPage: true,
    });
    const outgoing = b.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith(annotationUrl),
    );
    await save(b);
    const body = (await outgoing).postDataJSON();
    expect(body.baseRevision).toBe(1);
    expect(body.updated).toEqual([
      { id: m.id, x: m.x, y: m.y, content: "B仍在输入的价格说明" },
    ]);
    for (const page of p.pages) {
      await expect(page.locator(".annotation-card")).toHaveCount(2);
      await expect(page.locator(".annotation-list")).toContainText(
        "A刚保存的日期说明",
      );
      await expect(page.locator(".annotation-list")).toContainText(
        "B仍在输入的价格说明",
      );
    }
    expect((await read(p.contexts[0])).image.revision).toBe(3);
  } finally {
    await p.close();
  }
});

test("实时推送：删除草稿遇到远端修改会保留修改，远端删除也不丢正在输入的内容", async ({
  browser,
  baseURL,
}) => {
  const p = await pair(browser, baseURL);
  try {
    await seed(p.contexts[0]);
    await Promise.all(p.pages.map((page) => open(page)));
    const [a, b] = p.pages;
    await b.locator(".annotation-card").click();
    await b.getByRole("button", { name: "删除标记", exact: true }).click();
    await editOnly(a, "删除之前他人更新");
    await save(a);
    await expect(b.getByTestId("remote-updates")).toContainText(
      "删除之前他人更新",
    );
    await expect(b.locator(".annotation-card")).toHaveCount(0);
    await save(b);
    await expect(b.locator(".annotation-card")).toContainText(
      "删除之前他人更新",
    );
    await editOnly(b, "远端删除时还在编辑");
    await a.locator(".annotation-card").click();
    await a.getByRole("button", { name: "删除标记", exact: true }).click();
    await save(a);
    await expect(b.getByTestId("remote-updates")).toContainText("删除");
    await expect(b.getByLabel(/问题说明/)).toHaveValue("远端删除时还在编辑");
    await save(b);
    for (const page of p.pages)
      await expect(page.locator(".annotation-card")).toContainText(
        "远端删除时还在编辑",
      );
    const result = await read(p.contexts[0]);
    expect(result.annotations).toHaveLength(1);
  } finally {
    await p.close();
  }
});

test("实时推送：断线重连补查错过的更新并保护未保存草稿", async ({
  browser,
  baseURL,
}) => {
  const p = await pair(browser, baseURL);
  try {
    await seed(p.contexts[0]);
    await Promise.all(p.pages.map((page) => open(page)));
    const [a, b] = p.pages;
    await editOnly(b, "断网前未保存的内容");
    await p.contexts[1].setOffline(true);
    await expect(b.getByTestId("realtime-status")).toContainText("重连", {
      timeout: 15000,
    });
    await editOnly(a, "断线期间A保存的新内容");
    await save(a);
    await p.contexts[1].setOffline(false);
    await expect(b.getByTestId("realtime-status")).toHaveText(
      "实时同步已连接",
      { timeout: 15000 },
    );
    await expect(b.getByTestId("remote-updates")).toContainText(
      "断线期间A保存的新内容",
    );
    await expect(b.getByLabel(/问题说明/)).toHaveValue("断网前未保存的内容");
    await save(b);
    await expect(a.locator(".annotation-card")).toHaveCount(2);
  } finally {
    await p.contexts[1].setOffline(false);
    await p.close();
  }
});

test("实时推送：组内图片上传和删除自动更新图片选择，其他群组图片不进入列表", async ({
  browser,
  baseURL,
}) => {
  const p = await pair(browser, baseURL);
  try {
    const [a, b] = p.pages;
    await Promise.all(p.pages.map((page) => open(page)));
    const otherGroup = await p.contexts[0].request
      .post("/api/groups", { data: { name: "隔离实时通知群组" } })
      .then((r) => r.json());
    const png = await sharp({
      create: { width: 60, height: 80, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const unrelated = await p.contexts[0].request.post(
      `/api/images?groupId=${otherGroup.id}`,
      {
        multipart: {
          title: "不应进入默认组.png",
          image: { name: "elsewhere.png", mimeType: "image/png", buffer: png },
        },
      },
    );
    expect(unrelated.status()).toBe(201);
    await expect(
      b.getByLabel("图片选择", { exact: true }).locator("option"),
    ).toHaveCount(2);
    await a.locator('input[type="file"]').setInputFiles({
      name: "实时新增图片.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(
      b.getByLabel("图片选择", { exact: true }).locator("option"),
    ).toHaveCount(3);
    await expect(
      b.getByLabel("图片选择", { exact: true }).locator("option"),
    ).toContainText(["秋日", "轻行", "实时新增图片.png"]);
    await expect
      .poll(() => new URL(a.url()).searchParams.get("image"))
      .not.toBe(imageId);
    const uploadedId = new URL(a.url()).searchParams.get("image")!;
    expect(uploadedId).not.toBe(imageId);
    await b.getByLabel("图片选择", { exact: true }).selectOption(uploadedId);
    await expect(b.locator(".image-stage img")).toHaveJSProperty(
      "naturalWidth",
      60,
    );
    a.once("dialog", (dialog) => dialog.accept());
    await a.getByRole("button", { name: "删除照片", exact: true }).click();
    await expect(
      b.getByLabel("图片选择", { exact: true }).locator("option"),
    ).toHaveCount(2);
    await expect(b.getByLabel("图片选择", { exact: true })).not.toHaveValue(
      uploadedId,
    );
  } finally {
    await p.close();
  }
});

test("实时推送：照片被删除后保留只读草稿，可明确放弃并切换其他照片", async ({
  browser,
  baseURL,
}) => {
  const p = await pair(browser, baseURL);
  try {
    const b = p.pages[1];
    await open(b);
    await b.getByTestId("image-plane").click({ position: { x: 210, y: 200 } });
    await b.getByLabel(/问题说明/).fill("照片删除后仍需保留的文字");
    const deleted = await p.contexts[0].request.delete(
      `/api/images/${imageId}`,
      { data: { baseRevision: 0 } },
    );
    expect(deleted.status()).toBe(200);
    await expect(b.getByTestId("sync-warning")).toContainText("照片已被删除");
    await expect(b.getByLabel(/问题说明/)).toHaveValue(
      "照片删除后仍需保留的文字",
    );
    await expect(b.getByLabel(/问题说明/)).toBeDisabled();
    await expect(b.getByRole("button", { name: "保存标注" })).toBeDisabled();
    await expect(b.getByLabel("图片选择", { exact: true })).toBeEnabled();
    await b.getByLabel("图片选择", { exact: true }).selectOption("demo-poster");
    const dialog = b.getByRole("dialog", { name: "还有未保存的修改" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(b.getByLabel("图片选择", { exact: true })).toHaveValue(
      "demo-poster",
    );
    await expect(b.getByTestId("sync-warning")).toHaveCount(0);
    await expect(b.locator(".annotation-card")).toHaveCount(0);
    await b.getByTestId("image-plane").click({ position: { x: 210, y: 200 } });
    await expect(b.getByLabel(/问题说明/)).toBeEnabled();
  } finally {
    await p.close();
  }
});

test("实时推送：保存结果未确认时群组被删除，仍可复制草稿并确认离开", async ({
  browser,
  baseURL,
}) => {
  const p = await pair(browser, baseURL);
  try {
    const group = await p.contexts[0].request
      .post("/api/groups", { data: { name: "资源失效保护测试组" } })
      .then((r) => r.json());
    expect(
      (
        await p.contexts[1].request.post(`/api/groups/${group.id}/join`)
      ).status(),
    ).toBe(200);
    const png = await sharp({
      create: { width: 900, height: 1200, channels: 3, background: "#dfecd2" },
    })
      .png()
      .toBuffer();
    const uploaded = await p.contexts[0].request
      .post(`/api/images?groupId=${group.id}`, {
        multipart: {
          title: "群组删除保护.png",
          image: { name: "group.png", mimeType: "image/png", buffer: png },
        },
      })
      .then((r) => r.json());
    const id = uploaded.image.id;
    const b = p.pages[1];
    await open(b, group.id, id);
    await b.getByTestId("image-plane").click({ position: { x: 210, y: 200 } });
    await b.getByLabel(/问题说明/).fill("保存结果不明时仍要保留的草稿");
    await b.route(`**/api/images/${id}/annotations`, (route) =>
      route.abort("failed"),
    );
    await b.route(`**/api/images/${id}/submissions/*`, (route) =>
      route.abort("failed"),
    );
    await b.route(`**/api/images/${id}/review`, (route) =>
      route.abort("failed"),
    );
    await b.getByRole("button", { name: "保存标注" }).click();
    await expect(b.getByRole("status")).toHaveText("保存结果尚未确认");
    expect(
      (await p.contexts[0].request.delete(`/api/groups/${group.id}`)).status(),
    ).toBe(200);
    await expect(b.getByTestId("sync-warning")).toContainText("群组已被删除");
    await expect(b.getByLabel(/问题说明/)).toHaveValue(
      "保存结果不明时仍要保留的草稿",
    );
    await expect(b.getByRole("button", { name: "保存标注" })).toBeDisabled();
    // Keep clipboard verification inside this isolated page rather than changing the user's clipboard.
    await b.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as any).__copiedDraft = text;
          },
        },
      }),
    );
    await b.getByRole("button", { name: "复制本地说明", exact: true }).click();
    await expect
      .poll(() => b.evaluate(() => (window as any).__copiedDraft))
      .toContain("保存结果不明时仍要保留的草稿");
    const leave = b.getByRole("button", { name: "切换群组", exact: true });
    await expect(leave).toBeEnabled();
    b.once("dialog", (dialog) => dialog.accept());
    await leave.click();
    await expect(
      b.getByRole("heading", { name: "找到同伴，开始审图。" }),
    ).toBeVisible();
    await expect(b.getByRole("region", { name: "图片审核工作区" })).toHaveCount(
      0,
    );
  } finally {
    await p.close();
  }
});
