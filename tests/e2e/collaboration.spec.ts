import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
test.beforeEach(() => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/reset-test.ts"], {
    env: process.env,
  });
});
async function register(page: Page, name: string) {
  await page.getByRole("tab", { name: "注册", exact: true }).click();
  await page.getByLabel("账号名", { exact: true }).fill(name);
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(
    page.getByRole("heading", { name: "找到同伴，开始审图。" }),
  ).toBeVisible();
}
async function createGroup(page: Page, name: string) {
  await page.getByLabel("群组名字", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建并进入" }).click();
  await expect(
    page.getByRole("region", { name: "图片审核工作区" }),
  ).toBeVisible();
}

test("注册两个账号，创建群组、搜索直接加入并共同标注，刷新保持会话", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("tab", { name: "登录", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: "docs/verification/login.png",
    fullPage: true,
  });
  await register(page, "设计师阿宁");
  await page.screenshot({
    path: "docs/verification/groups.png",
    fullPage: true,
  });
  await createGroup(page, "秋日海报协作");
  const png = await sharp({
    create: { width: 900, height: 1200, channels: 3, background: "#dfecd2" },
  })
    .png()
    .toBuffer();
  await page.locator('input[type="file"]').setInputFiles({
    name: "团队海报.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.locator(".image-stage img")).toHaveJSProperty(
    "naturalWidth",
    900,
  );
  await page.getByTestId("image-plane").click({ position: { x: 150, y: 180 } });
  await page.getByLabel(/问题说明/).fill("请核对海报价格");
  await page.getByLabel(/问题说明/).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存");
  const a = (await page.request.get("/api/auth/session").then((r) => r.json()))
    .user;
  const imageId = new URL(page.url()).searchParams.get("image")!;
  const groupId = new URL(page.url()).searchParams.get("group")!;
  const uploaded = await page.request
    .get(`/api/images/${imageId}/review`)
    .then((r) => r.json());
  expect(uploaded.image.title).toBe("团队海报.png");
  await page.reload();
  await expect(page.getByText("设计师阿宁", { exact: true })).toBeVisible();
  await expect(page.locator(".pin")).toHaveCount(1);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByLabel("账号名", { exact: true })).toBeVisible();
  await register(page, "运营小顾");
  expect(
    (await page.request.get(`/api/images/${imageId}/review`)).status(),
  ).toBe(403);
  await page.getByLabel("搜索群组", { exact: true }).fill("秋日海报");
  await page.getByRole("button", { name: "搜索群组", exact: true }).click();
  const card = page.locator(".group-card").filter({
    has: page.getByRole("heading", { name: "秋日海报协作", exact: true }),
  });
  await card.getByRole("button", { name: "加入并进入" }).click();
  await expect(page.locator(".pin")).toHaveCount(1);
  await page.locator(".annotation-card").click();
  await page.getByLabel(/问题说明/).fill("运营已核对价格");
  await page.getByLabel(/问题说明/).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.getByTestId("image-plane").click({ position: { x: 250, y: 280 } });
  await page.getByLabel(/问题说明/).fill("再检查活动日期");
  await page.getByLabel(/问题说明/).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存");
  const b = (await page.request.get("/api/auth/session").then((r) => r.json()))
    .user;
  const review = await page.request
    .get(`/api/images/${imageId}/review`)
    .then((r) => r.json());
  expect(review.annotations[0].createdBy).toBe(a.id);
  expect(review.annotations[0].updatedBy).toBe(b.id);
  expect(review.annotations[1].createdBy).toBe(b.id);
  expect(
    (await page.request.get(`/api/groups/${groupId}`).then((r) => r.json()))
      .memberCount,
  ).toBe(2);
  await page.screenshot({
    path: "docs/verification/group-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换群组" }).click();
  await expect(
    page.getByRole("heading", { name: "找到同伴，开始审图。" }),
  ).toBeVisible();
  const unrelated = await page.request.get("/api/images?groupId=default-group");
  expect(unrelated.status()).toBe(403);
});

test("重名注册、未知账号和重名群组有提示，退出后可重新登录", async ({
  page,
}) => {
  await page.goto("/");
  await register(page, "Alice");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("tab", { name: "注册", exact: true }).click();
  await page.getByLabel("账号名", { exact: true }).fill("ａｌｉｃｅ");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("alert")).toContainText("已经注册");
  await page.getByRole("tab", { name: "登录", exact: true }).click();
  await page.getByLabel("账号名", { exact: true }).fill("还未注册");
  await page.getByRole("button", { name: "登录并进入" }).click();
  await expect(page.getByRole("alert")).toContainText("账号不存在");
  await page.getByLabel("账号名", { exact: true }).fill("ALICE");
  await page.getByRole("button", { name: "登录并进入" }).click();
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await createGroup(page, "唯一群组");
  await page.getByRole("button", { name: "切换群组" }).click();
  await page.getByLabel("群组名字", { exact: true }).fill("唯一群组");
  await page.getByRole("button", { name: "创建并进入" }).click();
  await expect(page.getByRole("alert")).toContainText("群组名已存在");
  await page.getByLabel("搜索群组", { exact: true }).fill("没有这个组");
  await page.getByRole("button", { name: "搜索群组", exact: true }).click();
  await expect(page.locator(".group-empty")).toContainText("没有找到群组");
});

test("删除照片可取消，失败保留草稿，成功后切到下一张并清理标记", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", { data: { name: "小林" } });
  await page.goto("/?group=default-group&image=demo-detail");
  await expect(page.locator(".image-stage img")).toBeVisible();
  await page.getByTestId("image-plane").click({ position: { x: 150, y: 180 } });
  await page.getByLabel(/问题说明/).fill("删除失败也要保留的草稿");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("未保存");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "删除照片", exact: true }).click();
  await expect(page.locator(".pin")).toHaveCount(1);
  await page.route("**/api/images/*", async (route) => {
    if (route.request().method() === "DELETE")
      await route.fulfill({ status: 500, json: { message: "测试删除失败" } });
    else await route.continue();
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除照片", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("测试删除失败");
  await expect(page.getByLabel(/问题说明/)).toHaveValue(
    "删除失败也要保留的草稿",
  );
  await page.unroute("**/api/images/*");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除照片", exact: true }).click();
  await expect(page.getByLabel("图片选择", { exact: true })).toHaveValue(
    "demo-poster",
  );
  await expect(page.locator(".pin")).toHaveCount(0);
  expect(
    (await page.request.get("/api/images/demo-detail/review")).status(),
  ).toBe(404);
});

test("组主删最后一张照片后显示空态，删群组确认后清理且其他账号不受影响", async ({
  page,
}) => {
  await page.goto("/");
  await register(page, "删除组主");
  await createGroup(page, "删除功能演示");
  const png = await sharp({
    create: { width: 900, height: 1200, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await page.locator('input[type="file"]').setInputFiles({
    name: "待删照片.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.locator(".image-stage img")).toHaveJSProperty(
    "naturalWidth",
    900,
  );
  const imageId = new URL(page.url()).searchParams.get("image")!;
  const groupId = new URL(page.url()).searchParams.get("group")!;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除照片", exact: true }).click();
  await expect(page.locator(".image-stage")).toHaveCount(0);
  await expect(page.locator(".empty-canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: /上传图片/ })).toBeEnabled();
  expect(
    (await page.request.get(`/api/images/${imageId}/content`)).status(),
  ).toBe(404);
  await page.getByRole("button", { name: "切换群组" }).click();
  const card = page.locator(".group-card").filter({
    has: page.getByRole("heading", { name: "删除功能演示", exact: true }),
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await card.getByRole("button", { name: "删除群组", exact: true }).click();
  await expect(card).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("所有照片及标记");
    await dialog.accept();
  });
  await card.getByRole("button", { name: "删除群组", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await page.request.get(`/api/groups/${groupId}`)).status()).toBe(404);
  expect(
    (await page.request.get("/api/auth/session").then((r) => r.json())).user
      .name,
  ).toBe("删除组主");
});

test("普通成员没有他人照片和群组的删除入口", async ({ page }) => {
  await page.goto("/");
  await register(page, "普通成员");
  await page.getByRole("button", { name: "加入并进入" }).click();
  await expect(page.locator(".image-stage img")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "删除照片", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "切换群组" }).click();
  await expect(
    page.getByRole("button", { name: "删除群组", exact: true }),
  ).toHaveCount(0);
});

test("删除期间保存快捷键禁用，照片和群组响应丢失后核对删除结果", async ({
  page,
}) => {
  await page.goto("/");
  await register(page, "删除核对");
  await createGroup(page, "结果核对组");
  const png = await sharp({
    create: { width: 900, height: 1200, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "核对.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".image-stage img")).toHaveJSProperty(
    "naturalWidth",
    900,
  );
  const imageId = new URL(page.url()).searchParams.get("image")!;
  const groupId = new URL(page.url()).searchParams.get("group")!;
  await page.getByTestId("image-plane").click({ position: { x: 150, y: 180 } });
  await page.getByLabel(/问题说明/).fill("删除期间不应自动保存");
  let puts = 0;
  page.on("request", (r) => {
    if (r.method() === "PUT") puts++;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/images/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await gate;
    await route.fetch();
    await route.abort("failed");
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除照片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除中…", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Control+s");
  release();
  await expect(page.locator(".image-stage")).toHaveCount(0);
  expect(puts).toBe(0);
  expect(
    (await page.request.get(`/api/images/${imageId}/review`)).status(),
  ).toBe(404);
  await page.getByRole("button", { name: "切换群组" }).click();
  await page.route("**/api/groups/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fetch();
    await route.abort("failed");
  });
  const card = page
    .locator(".group-card")
    .filter({
      has: page.getByRole("heading", { name: "结果核对组", exact: true }),
    });
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "删除群组", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await page.request.get(`/api/groups/${groupId}`)).status()).toBe(404);
});
