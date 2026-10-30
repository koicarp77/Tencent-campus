import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
const dir = await mkdtemp(join(tmpdir(), "review-desk-e2e-"));
await writeFile(join(dir, ".e2e-marker"), "review-desk");
const s = net.createServer();
await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
const port = s.address().port;
await new Promise((resolve) => s.close(resolve));
const env = {
  ...process.env,
  E2E_DIR: dir,
  DB_FILE: join(dir, "test.sqlite"),
  PORT: String(port),
  E2E_BASE_URL: `http://127.0.0.1:${port}`,
};
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
  { env, stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
const code = await new Promise((resolve) => child.on("exit", resolve));
await rm(dir, { recursive: true, force: true });
process.exitCode = code ?? 1;
