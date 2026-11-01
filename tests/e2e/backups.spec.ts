import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
test.beforeEach(() =>
  execFileSync(process.execPath, ["--import", "tsx", "scripts/reset-test.ts"], {
    env: process.env,
  }),
);
async function open(page: Page, name = "小林") {
  await page.request.post("/api/auth/login", { data: { name } });
  await page.goto("/?group=default-group&image=demo-detail");
  await expect(page.locator(".image-stage img")).toBeVisible();
}
async function add(page: Page, content: string, index = 0) {
  await page
    .getByTestId("image-plane")
    .click({ position: { x: 150 + index * 80, y: 180 + index * 60 } });
  await page.getByLabel(/问题说明/).fill(content);
}
async function backed(page: Page) {
  await expect(page.getByTestId("backup-status")).toContainText("草稿已备份");
}

test("未点保存的空白和文字草稿在异常关页后恢复，正式标注仍为空", async ({
  page,
  context,
}) => {
  await open(page);
  await add(page, "第一行\n崩溃恢复内容");
  await add(page, "", 1);
  await backed(page);
  const before = await page.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(before.annotations).toEqual([]);
  expect(before.image.revision).toBe(0);
  await page.close({ runBeforeUnload: false });
  const reopened = await context.newPage();
  await reopened.goto("/?group=default-group&image=demo-detail");
  await expect(reopened.getByTestId("draft-recovery")).toBeVisible();
  await reopened.screenshot({
    path: "docs/verification/draft-recovery.png",
    fullPage: true,
  });
  await reopened.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(reopened.locator(".pin")).toHaveCount(2);
  await reopened.locator(".annotation-card").first().click();
  await expect(reopened.getByLabel(/问题说明/)).toHaveValue(
    "第一行\n崩溃恢复内容",
  );
  await expect(reopened.getByRole("status")).toHaveText("有未保存修改");
  await reopened.getByRole("button", { name: "保存标注" }).click();
  await expect(reopened.getByRole("status")).toContainText("部分已保存");
  await backed(reopened);
  const after = await reopened.request
    .get("/api/images/demo-detail/review")
    .then((r) => r.json());
  expect(after.annotations).toHaveLength(1);
});

test("备份失败明确提示且可重试，恢复查询失败不会假报已备份", async ({
  page,
  context,
}) => {
  await open(page);
  await page.route("**/drafts/*", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { message: "备份故障注入" } })
      : route.continue(),
  );
  await add(page, "失败不丢输入");
  await expect(page.getByTestId("backup-status")).toContainText("草稿备份失败");
  await expect(page.getByLabel(/问题说明/)).toHaveValue("失败不丢输入");
  await page.unroute("**/drafts/*");
  await page.getByRole("button", { name: "重试备份" }).click();
  await backed(page);
  await page.close({ runBeforeUnload: false });
  const recovered = await context.newPage();
  await recovered.route("**/drafts", (route) =>
    route.fulfill({ status: 500, json: { message: "查询备份失败" } }),
  );
  await recovered.goto("/?group=default-group&image=demo-detail");
  await expect(recovered.getByTestId("backup-status")).toContainText(
    "无法查询可恢复草稿",
  );
  await recovered.unroute("**/drafts");
  await recovered.getByRole("button", { name: "重试备份" }).click();
  await expect(recovered.getByTestId("draft-recovery")).toBeVisible();
  await recovered
    .getByRole("button", { name: "恢复草稿", exact: true })
    .click();
  await expect(recovered.getByLabel(/问题说明/)).toHaveValue("失败不丢输入");
});

test("正式保存会清理备份，保存时仍在途的旧备份不会复活", async ({ page }) => {
  await open(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await page.route("**/drafts/*", async (route) => {
    if (route.request().method() === "PUT" && first) {
      first = false;
      await gate;
    }
    await route.continue();
  });
  await add(page, "等待备份");
  await expect(page.getByTestId("backup-status")).toContainText("正在备份");
  await page.getByLabel(/问题说明/).fill("正式保存的最新内容");
  await page.getByLabel(/问题说明/).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存");
  release();
  await expect
    .poll(async () =>
      page.request.get("/api/images/demo-detail/drafts").then((r) => r.json()),
    )
    .toEqual([]);
  await expect(page.getByTestId("backup-status")).toContainText(
    "草稿自动备份已开启",
  );
  await page.reload();
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0);
  await expect(page.locator(".annotation-card")).toContainText(
    "正式保存的最新内容",
  );
});

test("恢复旧版本草稿后保存，合并保留他人的正式修改", async ({
  page,
  context,
}) => {
  await open(page);
  await add(page, "我的未保存草稿");
  await backed(page);
  await page.close({ runBeforeUnload: false });
  await context.request.put("/api/images/demo-detail/annotations", {
    data: {
      baseRevision: 0,
      annotations: [
        {
          id: crypto.randomUUID(),
          x: 0.5,
          y: 0.5,
          content: "他人新标注",
          sortOrder: 0,
        },
      ],
    },
  });
  const recovered = await context.newPage();
  await recovered.goto("/?group=default-group&image=demo-detail");
  await recovered
    .getByRole("button", { name: "恢复草稿", exact: true })
    .click();
  await expect(recovered.getByRole("status")).not.toHaveText("版本冲突");
  await expect(recovered.getByLabel(/问题说明/)).toHaveValue("我的未保存草稿");
  await expect(
    recovered.getByRole("button", { name: "保存标注" }),
  ).toBeEnabled();
  await recovered.getByRole("button", { name: "保存标注" }).click();
  await expect(recovered.getByRole("status")).toHaveText("已保存");
  await expect(recovered.locator(".annotation-card")).toHaveCount(2);
  expect(
    (
      await recovered.request
        .get("/api/images/demo-detail/review")
        .then((r) => r.json())
    ).annotations[0].content,
  ).toBe("他人新标注");
});

test("两个窗口分别备份，其他账号看不到；明确放弃后不再提示", async ({
  page,
  context,
  browser,
}) => {
  await open(page);
  const second = await context.newPage();
  await second.goto("/?group=default-group&image=demo-detail");
  await expect(second.locator(".image-stage img")).toBeVisible();
  await add(page, "窗口甲草稿");
  await add(second, "窗口乙草稿");
  await backed(page);
  await backed(second);
  const rows = await page.request
    .get("/api/images/demo-detail/drafts")
    .then((r) => r.json());
  expect(rows).toHaveLength(2);
  const other = await browser.newContext();
  try {
    const b = await other.newPage();
    await open(b, "小周");
    await expect(b.getByTestId("draft-recovery")).toHaveCount(0);
    expect(
      await b.request
        .get("/api/images/demo-detail/drafts")
        .then((r) => r.json()),
    ).toEqual([]);
  } finally {
    await other.close();
  }
  await page.close({ runBeforeUnload: false });
  await second.close({ runBeforeUnload: false });
  const reopened = await context.newPage();
  await reopened.goto("/?group=default-group&image=demo-detail");
  await expect(reopened.getByTestId("draft-recovery")).toContainText("2 份");
  reopened.once("dialog", (dialog) => dialog.accept());
  await reopened.getByRole("button", { name: "放弃备份", exact: true }).click();
  await expect(reopened.getByTestId("draft-recovery")).toHaveCount(0);
  await reopened.reload();
  await expect(reopened.getByTestId("draft-recovery")).toHaveCount(0);
});

test("删除最后一个标记的草稿也能恢复，正式标注只在确认保存后清空", async ({
  page,
  context,
}) => {
  await open(page);
  await add(page, "原来已保存的标记");
  await page.getByLabel(/问题说明/).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.locator(".annotation-card").click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".pin")).toHaveCount(0);
  await backed(page);
  await page.close({ runBeforeUnload: false });
  const recovered = await context.newPage();
  await recovered.goto("/?group=default-group&image=demo-detail");
  await recovered
    .getByRole("button", { name: "恢复草稿", exact: true })
    .click();
  await expect(recovered.locator(".pin")).toHaveCount(0);
  expect(
    (
      await recovered.request
        .get("/api/images/demo-detail/review")
        .then((r) => r.json())
    ).annotations,
  ).toHaveLength(1);
  await recovered.getByRole("button", { name: "保存标注" }).click();
  await expect(recovered.getByRole("status")).toHaveText("已保存");
  expect(
    (
      await recovered.request
        .get("/api/images/demo-detail/review")
        .then((r) => r.json())
    ).annotations,
  ).toEqual([]);
});

test("持续输入期间也定期备份，不必等到停止打字", async ({ page }) => {
  await open(page);
  await add(page, "");
  const text = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  await page.getByLabel(/问题说明/).pressSequentially(text, { delay: 80 });
  const rows = await page.request
    .get("/api/images/demo-detail/drafts")
    .then((r) => r.json());
  expect(rows).toHaveLength(1);
  expect(rows[0].annotations[0].content.length).toBeGreaterThan(0);
  await backed(page);
  await expect
    .poll(async () => {
      const latest = await page.request
        .get("/api/images/demo-detail/drafts")
        .then((r) => r.json());
      return latest[0]?.annotations[0].content;
    })
    .toBe(text);
});

test("离开前确认备份，重新打开原图可恢复；明确放弃切图则清理备份", async ({
  page,
}) => {
  await open(page);
  await add(page, "离开后仍可恢复");
  const url = page.url();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "切换群组" }).click();
  await expect(
    page.getByRole("heading", { name: "找到同伴，开始审图。" }),
  ).toBeVisible();
  await page.goto(url);
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByLabel(/问题说明/)).toHaveValue("离开后仍可恢复");
  await backed(page);
  await page
    .getByLabel("图片选择", { exact: true })
    .selectOption("demo-poster");
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.getByLabel("图片选择", { exact: true })).toHaveValue(
    "demo-poster",
  );
  await page
    .getByLabel("图片选择", { exact: true })
    .selectOption("demo-detail");
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0);
  expect(
    await page.request
      .get("/api/images/demo-detail/drafts")
      .then((r) => r.json()),
  ).toEqual([]);
});

test("恢复查询失败后新写的文字不会被无提示替换，放弃旧备份仍备份当前新草稿", async ({
  page,
  context,
}) => {
  await open(page);
  await add(page, "之前的旧草稿");
  await backed(page);
  await page.close({ runBeforeUnload: false });
  const recovered = await context.newPage();
  await recovered.route("**/drafts", (route) =>
    route.fulfill({ status: 500, json: { message: "查询暂时失败" } }),
  );
  await recovered.goto("/?group=default-group&image=demo-detail");
  await expect(recovered.getByTestId("backup-status")).toContainText(
    "无法查询",
  );
  await add(recovered, "刚刚输入的新草稿");
  await recovered.unroute("**/drafts");
  await recovered.getByRole("button", { name: "重试备份" }).click();
  await expect(recovered.getByTestId("draft-recovery")).toBeVisible();
  recovered.once("dialog", (dialog) => dialog.dismiss());
  await recovered
    .getByRole("button", { name: "恢复草稿", exact: true })
    .click();
  await expect(recovered.getByLabel(/问题说明/)).toHaveValue(
    "刚刚输入的新草稿",
  );
  recovered.once("dialog", (dialog) => dialog.accept());
  await recovered
    .getByRole("button", { name: "放弃备份", exact: true })
    .click();
  await backed(recovered);
  const rows = await recovered.request
    .get("/api/images/demo-detail/drafts")
    .then((r) => r.json());
  expect(rows).toHaveLength(1);
  expect(rows[0].annotations[0].content).toBe("刚刚输入的新草稿");
});

test("备份响应丢失后查询版本重试，不留下过期分支，正式保存后无旧恢复提示", async ({
  page,
}) => {
  await open(page);
  let first = true;
  await page.route("**/drafts/*", async (route) => {
    if (first && route.request().method() === "PUT") {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await add(page, "第一版草稿");
  await expect(page.getByTestId("backup-status")).toContainText("草稿备份失败");
  await page.getByLabel(/问题说明/).fill("最新草稿");
  await page.getByRole("button", { name: "重试备份" }).click();
  await backed(page);
  const rows = await page.request
    .get("/api/images/demo-detail/drafts")
    .then((r) => r.json());
  expect(rows).toHaveLength(1);
  expect(rows[0].annotations[0].content).toBe("最新草稿");
  expect(rows[0].version).toBe(2);
  await page.getByLabel(/问题说明/).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(page.getByTestId("backup-status")).toContainText(
    "草稿自动备份已开启",
  );
  expect(
    await page.request
      .get("/api/images/demo-detail/drafts")
      .then((r) => r.json()),
  ).toEqual([]);
  await page.reload();
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0);
  await expect(page.locator(".annotation-card")).toContainText("最新草稿");
});

test("另一标签页切换账号后，旧窗口不会把私人草稿写到新账号", async ({
  page,
}) => {
  await open(page, "小林");
  await add(page, "小林的私人草稿");
  await backed(page);
  await page.getByLabel(/问题说明/).fill("旧窗口继续输入");
  await page.request.post("/api/auth/login", { data: { name: "小周" } });
  await expect(page.getByLabel(/问题说明/)).toBeDisabled();
  await expect(page.getByTestId("backup-status")).toContainText(
    "当前登录账号已变化",
  );
  expect(
    await page.request
      .get("/api/images/demo-detail/drafts")
      .then((r) => r.json()),
  ).toEqual([]);
  await page.request.post("/api/auth/login", { data: { name: "小林" } });
  await page.getByRole("button", { name: "重试备份" }).click();
  await backed(page);
  const rows = await page.request
    .get("/api/images/demo-detail/drafts")
    .then((r) => r.json());
  expect(rows[0].annotations[0].content).toBe("旧窗口继续输入");
});
