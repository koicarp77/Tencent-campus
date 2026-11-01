import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

test.beforeEach(() =>
  execFileSync(process.execPath, ["--import", "tsx", "scripts/reset-test.ts"], {
    env: process.env,
  }),
);

test("双账号同时修改同一标记，真实后端分别保存双方内容", async ({
  browser,
  baseURL,
}) => {
  const people = [
    { name: "小林", id: "operator-1", text: "小林：活动价应改为259元" },
    { name: "小周", id: "operator-2", text: "小周：活动日期需要补充" },
  ];
  const contexts = await Promise.all(
    people.map(() =>
      browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } }),
    ),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    for (let i = 0; i < people.length; i++) {
      const login = await contexts[i].request.post("/api/auth/login", {
        data: { name: people[i].name },
      });
      expect(login.status()).toBe(200);
    }
    const marker = {
      id: randomUUID(),
      x: 0.25,
      y: 0.3,
      content: "原始文案：活动价299元",
      sortOrder: 0,
    };
    const seed = await contexts[0].request.put(
      "/api/images/demo-detail/annotations",
      { data: { baseRevision: 0, annotations: [marker] } },
    );
    expect(seed.status()).toBe(200);
    const loaded = await Promise.all(
      pages.map(async (page) => {
        const response = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/images/demo-detail/review" &&
            r.request().method() === "GET",
        );
        await page.goto("/?group=default-group&image=demo-detail");
        const data = await (await response).json();
        await expect(page.locator(".annotation-card")).toHaveCount(1);
        return data;
      }),
    );
    expect(loaded.map((r) => r.image.revision)).toEqual([1, 1]);
    for (let i = 0; i < pages.length; i++) {
      await pages[i].locator(".annotation-card").click();
      await pages[i].getByLabel(/问题说明/).fill(people[i].text);
    }
    let count = 0,
      arrive!: () => void;
    const bothArrived = new Promise<void>((resolve) => (arrive = resolve));
    const submitted: any[] = [];
    await Promise.all(
      pages.map((page, i) =>
        page.route("**/api/images/demo-detail/annotations", async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          submitted[i] = route.request().postDataJSON();
          count++;
          if (count === 2) arrive();
          // No response is mocked: wait for both requests, then release them together.
          await gate;
          await route.continue();
        }),
      ),
    );
    const responses = pages.map((page) =>
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/images/demo-detail/annotations" &&
          r.request().method() === "PATCH",
      ),
    );
    await Promise.all(
      pages.map((page) =>
        page.getByRole("button", { name: "保存标注" }).click(),
      ),
    );
    await bothArrived;
    expect(submitted.map((r) => r.baseRevision)).toEqual([1, 1]);
    await Promise.all(
      pages.map((page) =>
        expect(page.getByRole("status")).toHaveText("保存中…"),
      ),
    );
    release();
    const results = await Promise.all(responses);
    const statuses = results.map((r) => r.status());
    expect(statuses).toEqual([200, 200]);
    for (const page of pages)
      await expect(page.getByRole("status")).toHaveText("已保存");
    const persisted = await contexts[0].request
      .get("/api/images/demo-detail/review")
      .then((r) => r.json());
    expect(persisted.image.revision).toBe(3);
    expect(persisted.annotations).toHaveLength(2);
    expect(new Set(persisted.annotations.map((a: any) => a.id)).size).toBe(2);
    expect(persisted.annotations.map((a: any) => a.content).sort()).toEqual(
      people.map((p) => p.text).sort(),
    );
    expect(persisted.annotations[0].id).toBe(marker.id);
    expect(Date.parse(persisted.annotations[1].createdAt)).toBeGreaterThan(
      Date.parse(persisted.annotations[0].updatedAt),
    );
    for (const context of contexts) {
      await expect
        .poll(async () =>
          context.request
            .get("/api/images/demo-detail/drafts")
            .then((r) => r.json()),
        )
        .toEqual([]);
    }
    for (const page of pages) {
      await expect(page.locator(".annotation-card")).toHaveCount(2);
      await expect(page.locator(".pin")).toHaveCount(2);
      // Same coordinates remain independently clickable.
      for (let i = 0; i < 2; i++) {
        await page.locator(".pin").nth(i).click();
        await expect(page.getByLabel(/问题说明/)).toHaveValue(
          persisted.annotations[i].content,
        );
      }
    }
    mkdirSync("docs/verification", { recursive: true });
    await Promise.all(
      pages.map((page, i) =>
        page.screenshot({
          path: `docs/verification/concurrency-${i === 0 ? "xiaolin" : "xiaozhou"}.png`,
          fullPage: true,
        }),
      ),
    );
    const report = {
      executedAt: new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      }),
      scenario:
        "同一群组、同一图片、同一标记、两个独立账号及浏览器上下文；两个PATCH都到达拦截点后同时放行；所有请求和响应均来自真实后端",
      initialRevision: 1,
      requests: people.map((p, i) => ({
        account: p.name,
        actorId: p.id,
        baseRevision: submitted[i].baseRevision,
        content: submitted[i].updated[0].content,
        httpStatus: statuses[i],
        uiStatus: "已保存",
      })),
      finalRevision: persisted.image.revision,
      annotations: persisted.annotations,
    };
    writeFileSync(
      "docs/verification/concurrency-demo.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    writeFileSync(
      "docs/verification/concurrency-demo.md",
      `# 双账号并发修改实测

执行时间（Asia/Shanghai）：${report.executedAt}。隔离临时SQLite。

两个账号同时打开版本1、修改同一标记，两个PATCH均到达拦截点后一起放行，真实后端响应均为200。最终版本3，双方内容成为两个独立ID的标记，按后端接收处理的时间顺序保留。原标记保留第一份修改，第二份创建新标记。

${persisted.annotations.map((a: any, i: number) => `${i + 1}. ${a.content}（修改者${a.updatedByName}，服务端修改时间${a.updatedAt}）`).join("\n")}

双方页面通过实时通知自动显示两条，无需刷新，可分别点击同位置编号查看。

[小林截图](concurrency-xiaolin.png)、[小周截图](concurrency-xiaozhou.png)、[原始结果](concurrency-demo.json)。

复现：\`E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- --grep '双账号同时修改同一标记'\`。数据库写事务顺序执行；时间以服务端为准，不信任客户端时钟。
`,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    release();
    await Promise.all(contexts.map((c) => c.close()));
  }
});
