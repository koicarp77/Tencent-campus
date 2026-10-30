import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
test.beforeEach(async () => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/reset-test.ts"], {
    env: process.env,
  });
});
async function open(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("图片选择", { exact: true })
    .selectOption("demo-detail");
  await expect(page.locator(".image-stage img")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".image-stage img")
        .evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
    )
    .toBe(true);
}
async function add(page: Page, text = "价格需要确认") {
  const count = await page.locator(".pin").count();
  await page
    .getByTestId("image-plane")
    .click({ position: { x: 150 + count * 70, y: 180 + count * 50 } });
  await page.getByLabel(/问题说明/).fill(text);
}
async function save(page: Page) {
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
}
test("落点、缩放、滚动、保存刷新及清空", async ({ page }) => {
  await open(page);
  await add(page);
  await save(page);
  await page.reload();
  await expect(page.locator(".pin")).toHaveCount(1);
  for (const zoom of ["50%", "200%"]) {
    await page.getByRole("button", { name: zoom, exact: true }).click();
    await page.getByTestId("viewport").evaluate((e) => {
      e.scrollTop = 100;
      e.scrollLeft = 80;
    });
    const delta = await page.locator(".pin").evaluate((e) => {
      const p = e.getBoundingClientRect(),
        im = e.parentElement!.getBoundingClientRect();
      return {
        x: (p.x + p.width / 2 - im.x) / im.width,
        y: (p.y + p.height / 2 - im.y) / im.height,
      };
    });
    const stored = await page.request
      .get("/api/images/demo-detail/review")
      .then((r) => r.json());
    expect(delta.x).toBeCloseTo(stored.annotations[0].x, 3);
    expect(delta.y).toBeCloseTo(stored.annotations[0].y, 3);
  }
  await page.locator(".annotation-card").click();
  await page.getByRole("button", { name: "删除标记" }).click();
  await save(page);
  await page.reload();
  await expect(page.locator(".pin")).toHaveCount(0);
});
test("主动注入500：保留草稿、恢复重试后真实持久化", async ({ page }) => {
  await open(page);
  await add(page, "失败后也不能丢失");
  await page.route("**/annotations", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SIMULATED_SAVE_FAILURE",
        message: "验证用保存失败",
      }),
    }),
  );
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toHaveText("保存失败");
  await expect(page.getByLabel(/问题说明/)).toHaveValue("失败后也不能丢失");
  mkdirSync("docs/verification", { recursive: true });
  await page.screenshot({ path: "docs/verification/save-failure.png" });
  await page.unroute("**/annotations");
  await save(page);
  await page.reload();
  await expect(page.locator(".annotation-card")).toContainText(
    "失败后也不能丢失",
  );
});
test("真实提交但响应丢失：核对成功，不重复写入", async ({ page }) => {
  await open(page);
  await add(page, "响应丢失用例");
  await page.route("**/annotations", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(page.getByRole("alert")).toContainText("已核对");
  const data = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(data.image.revision).toBe(1);
  expect(data.annotations).toHaveLength(1);
});
test("两个页面冲突，保留B草稿且不覆盖A", async ({ page, context }) => {
  await open(page);
  const b = await context.newPage();
  await open(b);
  await add(page, "A的保存");
  await add(b, "B的草稿");
  await save(page);
  await b.getByRole("button", { name: "保存标注" }).click();
  await expect(b.getByRole("status")).toHaveText("版本冲突");
  await expect(b.getByLabel(/问题说明/)).toHaveValue("B的草稿");
  const data = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(data.annotations[0].content).toBe("A的保存");
});
test("保存后切人使用原身份，明确失败时留在原人", async ({ page }) => {
  await open(page);
  await add(page, "小林的标记");
  await page.getByLabel("操作人", { exact: true }).selectOption("operator-2");
  await page.getByRole("button", { name: "保存后切换" }).click();
  await expect(page.getByLabel("操作人", { exact: true })).toHaveValue(
    "operator-2",
  );
  const data = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(data.annotations[0].createdBy).toBe("operator-1");
  await add(page, "小周的草稿");
  await page.route("**/annotations", (route) =>
    route.fulfill({ status: 500, json: { message: "验证失败" } }),
  );
  await page.getByLabel("操作人", { exact: true }).selectOption("operator-1");
  await page.getByRole("button", { name: "保存后切换" }).click();
  await expect(page.getByLabel("操作人", { exact: true })).toHaveValue(
    "operator-2",
  );
  await expect(page.getByLabel(/问题说明/)).toHaveValue("小周的草稿");
});
test("已提交后另一人修改再丢失响应：核对为冲突", async ({ page }) => {
  await open(page);
  await add(page, "我的旧提交");
  await page.route("**/annotations", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await page.request.put("/api/images/demo-detail/annotations", {
      data: {
        actorId: "operator-2",
        baseRevision: data.image.revision,
        annotations: data.annotations.map((a: any) => ({
          ...a,
          content: "其他人后续修改",
        })),
      },
    });
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toHaveText("版本冲突");
  await expect(page.getByLabel(/问题说明/)).toHaveValue("我的旧提交");
});
test("点击标记和留白不新增；空说明阻止保存", async ({ page }) => {
  await open(page);
  await add(page, "");
  await page.locator(".pin").click();
  await expect(page.locator(".pin")).toHaveCount(1);
  await page.getByTestId("viewport").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".pin")).toHaveCount(1);
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("alert")).toContainText("1—500");
});
test("视口中心缩放锚点、窗口适应宽度和固定命中尺寸", async ({ page }) => {
  await open(page);
  await add(page);
  await page.getByRole("button", { name: "100%", exact: true }).click();
  await page.getByTestId("viewport").evaluate((e) => {
    e.scrollTop = 650;
    e.scrollLeft = 0;
  });
  const center = () =>
    page.getByTestId("viewport").evaluate((e) => {
      const v = e.getBoundingClientRect(),
        p = e.querySelector(".image-stage")!.getBoundingClientRect();
      return {
        x: (v.left + e.clientWidth / 2 - p.left) / p.width,
        y: (v.top + e.clientHeight / 2 - p.top) / p.height,
      };
    });
  const before = await center();
  await page.getByRole("button", { name: "200%", exact: true }).click();
  await expect
    .poll(async () => Math.abs((await center()).y - before.y) * 5200)
    .toBeLessThanOrEqual(2);
  const box = await page.locator(".pin").boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  await page.getByRole("button", { name: "适应宽度", exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect
    .poll(async () => {
      const im = await page.getByTestId("image-plane").boundingBox();
      const vp = await page.getByTestId("viewport").boundingBox();
      return im!.width <= vp!.width - 79;
    })
    .toBe(true);
  await page.locator(".annotation-card").click();
  await expect(page.getByLabel(/问题说明/)).toBeInViewport();
  await expect(page.locator(".pin")).toBeInViewport();
  await page.screenshot({
    path: "docs/verification/workspace.png",
    fullPage: true,
  });
});
