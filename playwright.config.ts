import { defineConfig } from "@playwright/test";
if (!process.env.E2E_BASE_URL || !process.env.DB_FILE || !process.env.E2E_DIR)
  throw new Error("请通过 npm run test:e2e 启动隔离测试");
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    channel: process.env.E2E_BROWSER_CHANNEL,
    baseURL: process.env.E2E_BASE_URL,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run e2e:serve",
    url: `${process.env.E2E_BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120000,
  },
  timeout: 30000,
});
