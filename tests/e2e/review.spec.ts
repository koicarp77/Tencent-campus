import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
test.beforeEach(async () => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/reset-test.ts"], {
    env: process.env,
  });
});
async function open(page: Page) {
  const session = await page.request
    .get("/api/auth/session")
    .then((r) => r.json());
  if (!session.user) {
    const auth = await page.request.post("/api/auth/login", {
      data: { name: "小林" },
    });
    expect(auth.status()).toBe(200);
  }
  await page.goto("/?group=default-group");
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
test("两个页面新增标记，后端合并并显示双方内容", async ({ page, context }) => {
  await open(page);
  const b = await context.newPage();
  await open(b);
  await add(page, "A的保存");
  await add(b, "B的草稿");
  await save(page);
  await b.getByRole("button", { name: "保存标注" }).click();
  await expect(b.getByRole("status")).toHaveText("已保存");
  await expect(b.locator(".annotation-card")).toHaveCount(2);
  const data = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(data.annotations.map((a: any) => a.content)).toEqual([
    "A的保存",
    "B的草稿",
  ]);
});
test("操作归属来自登录会话，退出登录前草稿可取消", async ({ page }) => {
  await open(page);
  await add(page, "小林的标记");
  await save(page);
  const data = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(data.annotations[0].createdBy).toBe("operator-1");
  await add(page, "尚未保存的草稿");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByLabel(/问题说明/)).toHaveValue("尚未保存的草稿");
  expect(
    (await page.request.get("/api/auth/session").then((r) => r.json())).user
      .name,
  ).toBe("小林");
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

test("真实PNG上传响应延迟13秒后仍能打开、标注和保存", async ({ page }) => {
  await open(page);
  const { default: sharp } = await import("sharp");
  const png = await sharp({
    create: { width: 900, height: 1200, channels: 3, background: "#e5ebda" },
  })
    .png()
    .toBuffer();
  await page.route("**/api/images?*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // Real upload and database write first; deliberately delay the response
    // beyond the old 12-second deadline to reproduce the reported failure.
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 13_000));
    await route.fulfill({ response });
  });
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/images") &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "png-timeout-regression.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByRole("button", { name: /处理图片中/ })).toBeDisabled();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const data = await response.json();
  await expect(page.getByLabel("图片选择", { exact: true })).toHaveValue(
    data.image.id,
  );
  await expect(page.locator(".image-stage img")).toHaveJSProperty(
    "naturalWidth",
    900,
  );
  await add(page, "PNG上传后可以正常标注");
  await save(page);
  await page.reload();
  await expect(page.locator(".annotation-card")).toContainText(
    "PNG上传后可以正常标注",
  );
});

test("localhost页面跳转到127.0.0.1并完成真实PNG上传", async ({
  page,
  baseURL,
}) => {
  await page.request.post("/api/auth/login", { data: { name: "小林" } });
  await page.goto(
    baseURL!.replace("127.0.0.1", "localhost") +
      "/?group=default-group&image=demo-detail",
  );
  await expect(page).toHaveURL(
    /http:\/\/127\.0\.0\.1:\d+\/\?group=default-group&image=demo-detail/,
  );
  await expect(page.getByLabel("图片选择", { exact: true })).toHaveValue(
    "demo-detail",
  );
  const { default: sharp } = await import("sharp");
  const png = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/images") &&
      response.request().method() === "POST",
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "loopback-upload.png",
    mimeType: "image/png",
    buffer: png,
  });
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(new URL(response.url()).hostname).toBe("127.0.0.1");
  const data = await response.json();
  await expect(page.getByLabel("图片选择", { exact: true })).toHaveValue(
    data.image.id,
  );
  await expect(page.locator(".image-stage img")).toHaveJSProperty(
    "naturalWidth",
    100,
  );
});

test("Shift滚轮与捏合缩放保持锚点，普通滚轮及双指滑动保持平移", async ({
  page,
}) => {
  await open(page);
  await add(page, "手势缩放不改变位置");
  await page.getByRole("button", { name: "100%", exact: true }).click();
  await page.getByTestId("viewport").evaluate((e) => {
    e.scrollTop = 650;
  });
  const viewport = page.getByTestId("viewport");
  const rect = await viewport.boundingBox();
  const x = rect!.x + rect!.width * 0.6,
    y = rect!.y + rect!.height * 0.4;
  const read = () =>
    viewport.evaluate(
      (e, position) => {
        const p = e.querySelector(".image-stage")!.getBoundingClientRect();
        const pin = e.querySelector(".pin")!.getBoundingClientRect();
        return {
          width: p.width,
          height: p.height,
          x: (position.x - p.left) / p.width,
          y: (position.y - p.top) / p.height,
          pinX: (pin.x + pin.width / 2 - p.x) / p.width,
          pinY: (pin.y + pin.height / 2 - p.y) / p.height,
          pinWidth: pin.width,
          scroll: e.scrollTop,
        };
      },
      { x, y },
    );
  const before = await read();
  await page.mouse.move(x, y);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Shift");
  await expect
    .poll(async () => (await read()).width)
    .toBeGreaterThan(before.width);
  const after = await read();
  expect(Math.abs(after.x - before.x) * after.width).toBeLessThanOrEqual(2);
  expect(Math.abs(after.y - before.y) * after.height).toBeLessThanOrEqual(2);
  expect(after.pinX).toBeCloseTo(before.pinX, 4);
  expect(after.pinY).toBeCloseTo(before.pinY, 4);
  expect(after.pinWidth).toBe(before.pinWidth);
  // Chromium maps trackpad pinch to wheel events carrying ctrlKey.
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -40);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => (await read()).width)
    .toBeGreaterThan(after.width);
  const pinched = await read();
  await page.mouse.wheel(0, 160);
  await expect
    .poll(async () => (await read()).scroll)
    .toBeGreaterThan(pinched.scroll);
  expect((await read()).width).toBe(pinched.width);
  // Precise deltaMode=0 events are also used by two-finger trackpad panning.
  const accepted = await viewport.evaluate((e) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 12,
      deltaX: 3,
      deltaMode: 0,
    });
    e.dispatchEvent(event);
    return !event.defaultPrevented;
  });
  expect(accepted).toBe(true);
  expect((await read()).width).toBe(pinched.width);

  await save(page);
  await page.reload();
  await expect(page.locator(".pin")).toHaveCount(1);
});

test("连续滚轮限制10%到400%，Safari手势事件按起始比例缩放", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "100%", exact: true }).click();
  const viewport = page.getByTestId("viewport"),
    plane = page.getByTestId("image-plane");
  const burst = async (deltaY: number) =>
    viewport.evaluate((e, delta) => {
      const r = e.getBoundingClientRect();
      for (let i = 0; i < 30; i++)
        e.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: delta,
            shiftKey: true,
            clientX: r.x + r.width / 2,
            clientY: r.y + r.height / 2,
          }),
        );
    }, deltaY);
  await burst(-240);
  await expect.poll(async () => (await plane.boundingBox())!.width).toBe(3600);
  await burst(240);
  await expect.poll(async () => (await plane.boundingBox())!.width).toBe(90);
  await page.getByRole("button", { name: "100%", exact: true }).click();
  // Synthetic Safari-shaped events verify the fallback handler; this is not
  // a claim of testing a physical Safari trackpad.
  await viewport.evaluate((e) => {
    const r = e.getBoundingClientRect();
    for (const [type, scale] of [
      ["gesturestart", 1],
      ["gesturechange", 1.5],
      ["gesturechange", 2],
      ["gestureend", 2],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        scale,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      });
      e.dispatchEvent(event);
    }
  });
  await expect.poll(async () => (await plane.boundingBox())!.width).toBe(1800);
  await expect(page.locator(".pin")).toHaveCount(0);
});

test("Delete与Mac退格键删除选中标记，长按不连删，保存刷新生效", async ({
  page,
}) => {
  await open(page);
  await add(page, "第一条");
  await add(page, "第二条");
  await save(page);
  await page.locator(".annotation-card").first().click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".pin")).toHaveCount(1);
  await expect(page.locator(".annotation-card")).toContainText("第二条");
  await expect(page.getByRole("status")).toHaveText("有未保存修改");
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(page.locator(".pin")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(page.locator(".pin")).toHaveCount(0);
  // Saving the empty collection remains enabled after keyboard deletion.
  await save(page);
  await page.reload();
  await expect(page.locator(".pin")).toHaveCount(0);
});

test("输入说明时删除键只删文字，切换弹窗与保存期间不删除标记", async ({
  page,
}) => {
  await open(page);
  await add(page, "abc");
  const editor = page.getByLabel(/问题说明/);
  await editor.press("End");
  await editor.press("Backspace");
  await expect(editor).toHaveValue("ab");
  await editor.press("ArrowLeft");
  await editor.press("ArrowLeft");
  await editor.press("Delete");
  await expect(editor).toHaveValue("b");
  await expect(page.locator(".pin")).toHaveCount(1);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("未保存");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "切换群组" }).click();
  await expect(page.locator(".pin")).toHaveCount(1);
  // Wait for an observable in-flight save, instead of an arbitrary delay.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/annotations", async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toHaveText("保存中…");
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(page.locator(".pin")).toHaveCount(1);
  release();
  await expect(page.getByRole("status")).toHaveText("已保存");
});

test("第一条空说明不阻塞后续标记保存，补全后可保存全部并刷新恢复", async ({
  page,
}) => {
  await open(page);
  await add(page, "");
  await add(page, "第二条可独立保存");
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toHaveText("部分已保存 · 仍有草稿");
  await expect(page.getByRole("alert")).toContainText("还有 1 条");
  await expect(page.locator(".pin")).toHaveCount(2);
  const saved = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(saved.annotations).toHaveLength(1);
  expect(saved.annotations[0].content).toBe("第二条可独立保存");
  await page.locator(".annotation-card").first().click();
  await page.getByLabel(/问题说明/).fill("补全第一条");
  await save(page);
  await page.reload();
  await expect(page.locator(".pin")).toHaveCount(2);
  await expect(page.locator(".annotation-card").first()).toContainText(
    "第二条可独立保存",
  );
  await expect(page.locator(".annotation-card").nth(1)).toContainText(
    "补全第一条",
  );
});

test("空白草稿保留且刷新后已完成标记独立恢复", async ({ page }) => {
  await open(page);
  await add(page, "");
  await add(page, "先保存第二条");
  await page.getByRole("button", { name: "保存标注" }).click();
  await expect(page.getByRole("status")).toContainText("部分已保存");
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.locator(".pin")).toHaveCount(1);
  await expect(page.locator(".annotation-card")).toContainText("先保存第二条");
});

test("说明中Enter保存，Shift+Enter换行并保留持久化内容", async ({ page }) => {
  await open(page);
  await add(page, "第一行");
  const editor = page.getByLabel(/问题说明/);
  await editor.press("Shift+Enter");
  await page.keyboard.insertText("第二行");
  await expect(editor).toHaveValue("第一行\n第二行");
  const before = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(before.image.revision).toBe(0);
  await editor.press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.reload();
  await page.locator(".annotation-card").click();
  await expect(page.getByLabel(/问题说明/)).toHaveValue("第一行\n第二行");
});

test("中文输入法确认与长按Enter不保存，Enter部分保存保留空白草稿", async ({
  page,
}) => {
  await open(page);
  await add(page, "");
  await add(page, "中文说明");
  const editor = page.getByLabel(/问题说明/);
  // Include Safari's keyCode=229 fallback when isComposing is false.
  await editor.evaluate((e) => {
    e.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    e.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      }),
    );
    e.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByRole("status")).toHaveText("有未保存修改");
  const before = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(before.image.revision).toBe(0);
  await editor.press("Enter");
  await expect(page.getByRole("status")).toHaveText("部分已保存 · 仍有草稿");
  await expect(page.locator(".pin")).toHaveCount(2);
  const after = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(after.annotations).toHaveLength(1);
  expect(after.annotations[0].content).toBe("中文说明");
});

test("100个标记修改一条只发送一条增量，删除仅提交ID", async ({ page }) => {
  await open(page);
  const annotations = Array.from({ length: 100 }, (_, i) => ({
    id: crypto.randomUUID(),
    x: (i % 10) / 12 + 0.05,
    y: Math.floor(i / 10) / 12 + 0.05,
    content: `已有标记${i + 1}`,
    sortOrder: i,
  }));
  const seed = await page.request.put("/api/images/demo-detail/annotations", {
    data: { baseRevision: 0, annotations },
  });
  expect(seed.status()).toBe(200);
  await page.reload();
  await expect(page.locator(".annotation-card")).toHaveCount(100);
  await page.locator(".annotation-card").nth(7).click();
  await page.getByLabel(/问题说明/).fill("只修改第八条");
  const request = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/annotations"),
  );
  await save(page);
  const sent = (await request).postDataJSON();
  expect(sent.annotations).toBeUndefined();
  expect(sent.added).toEqual([]);
  expect(sent.deleted).toEqual([]);
  expect(sent.updated).toEqual([
    {
      id: annotations[7].id,
      x: annotations[7].x,
      y: annotations[7].y,
      content: "只修改第八条",
    },
  ]);
  await page.locator(".annotation-card").nth(7).click();
  await page.getByRole("button", { name: "删除标记", exact: true }).click();
  const deletion = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/annotations"),
  );
  await save(page);
  const removed = (await deletion).postDataJSON();
  expect(removed.updated).toEqual([]);
  expect(removed.added).toEqual([]);
  expect(removed.deleted).toEqual([annotations[7].id]);
  const persisted = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(persisted.annotations).toHaveLength(99);
  expect(
    persisted.annotations.find((a: any) => a.id === annotations[6].id).content,
  ).toBe("已有标记7");
});
