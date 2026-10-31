import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "review-desk-clean-"));
async function run(command, args, cwd) {
  console.log(`RUN ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      E2E_BROWSER_CHANNEL: process.env.E2E_BROWSER_CHANNEL || "chrome",
    },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (code !== 0) throw new Error(`${command} failed: ${code}`);
}
try {
  const checkout = join(directory, "checkout");
  await run("git", ["clone", "--no-hardlinks", root, checkout], directory);
  for (const args of [
    ["ci"],
    ["run", "db:setup"],
    ["run", "typecheck"],
    ["test"],
    ["run", "build"],
    ["run", "test:smoke"],
    ["run", "test:e2e"],
  ])
    await run("npm", args, checkout);
  for (const file of ["save-failure.png", "workspace.png"])
    await copyFile(
      join(checkout, "docs/verification", file),
      join(root, "docs/verification", file),
    );
  console.log(
    "PASS: 干净克隆无node_modules、无数据库，完整安装、初始化、检查、构建、重启验证及浏览器测试全部通过",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
