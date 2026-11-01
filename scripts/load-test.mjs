/** Loopback-only HTTP/SSE load experiment. Every write goes to a fresh temporary file DB. */
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { tmpdir, cpus, totalmem, platform, arch, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import http from "node:http";
import net from "node:net";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import Database from "better-sqlite3";
const root = fileURLToPath(new URL("../", import.meta.url));
const options = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const [key, data] = value.replace(/^--/, "").split("=");
    return [key, data];
  }),
);
const levels = (options.levels || "10,50,100").split(",").map(Number);
function integerOption(key, fallback, min, max) {
  const value = Number(options[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`invalid --${key}`);
  return value;
}
if (
  !levels.length ||
  levels.some((n) => !Number.isInteger(n) || n < 1 || n > 100)
)
  throw new Error("levels must be integers 1..100");
const config = {
  levels: [...new Set(levels)].sort((a, b) => a - b),
  readSeconds: integerOption("read-seconds", 10, 1, 60),
  writeIterations: integerOption("write-iterations", 20, 1, 100),
  sseUpdates: integerOption("sse-updates", 10, 1, 50),
  sseIntervalMs: 250,
  maxReadRequestsPerStage: 20000,
  requestTimeoutMs: 12000,
  accountCount: Math.max(...levels),
  realBrowserUsers: 0,
};
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomUUID().slice(0, 6);
const directory = await mkdtemp(join(tmpdir(), "review-desk-load-"));
await writeFile(join(directory, ".load-marker"), "review-desk-load");
const output = resolve(root, "docs/verification/load-test", runId);
await mkdir(output, { recursive: true });
const dbFile = join(directory, "fixture.sqlite");
const raw = createWriteStream(join(output, "requests.jsonl"));
const resourcesOut = createWriteStream(join(output, "resources.jsonl"));
const serverLog = createWriteStream(join(output, "server-output.txt"));
const csv = createWriteStream(join(output, "requests.csv"));
csv.write(
  "scenario,kind,worker,iteration,startedAt,method,path,status,ok,latencyMs,requestBytes,responseBytes,errorCode,revision,observedRevision\n",
);
const rows = [],
  resourceSamples = [],
  checks = [],
  scenarios = [],
  images = new Map(),
  accounts = [];
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 256,
  maxFreeSockets: 128,
});
let child,
  base,
  activeScenario = "setup",
  fatal = null;
const startedAt = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
function record(row) {
  row.scenario = activeScenario;
  rows.push(row);
  raw.write(JSON.stringify(row) + "\n");
  csv.write(
    [
      "scenario",
      "kind",
      "worker",
      "iteration",
      "startedAt",
      "method",
      "path",
      "status",
      "ok",
      "latencyMs",
      "requestBytes",
      "responseBytes",
      "errorCode",
      "revision",
      "observedRevision",
    ]
      .map((key) => esc(row[key]))
      .join(",") + "\n",
  );
}
function check(name, passed, detail) {
  const result = { name, passed: !!passed, detail };
  checks.push({ ...result, scenario: activeScenario });
  return result;
}
function percentile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.max(0, Math.ceil(a.length * p) - 1)];
}
function latency(values) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
    mean: values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null,
  };
}
function stats(data, elapsedMs) {
  const statusCounts = {};
  for (const r of data)
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  const successful = data.filter((r) => r.ok).length;
  return {
    requests: data.length,
    successful,
    failed: data.length - successful,
    errorRate: data.length ? (data.length - successful) / data.length : 0,
    rps: elapsedMs > 0 ? data.length / (elapsedMs / 1000) : 0,
    latencyMs: latency(data.map((r) => r.latencyMs)),
    statusCounts,
    requestBytes: data.reduce((n, r) => n + (r.requestBytes || 0), 0),
    responseBytes: data.reduce((n, r) => n + (r.responseBytes || 0), 0),
  };
}
async function rpc(
  path,
  {
    method = "GET",
    cookie = "",
    body,
    kind = "http",
    worker,
    iteration,
    measure = true,
  } = {},
) {
  const start = performance.now(),
    startedAt = new Date().toISOString(),
    payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    let complete = false;
    const finish = (status, data, bytes, errorCode, headers = {}) => {
      if (complete) return;
      complete = true;
      const row = {
        kind,
        worker,
        iteration,
        startedAt,
        method,
        path,
        status,
        ok: status >= 200 && status < 300 && !errorCode,
        latencyMs: performance.now() - start,
        requestBytes: payload?.length || 0,
        responseBytes: bytes,
        errorCode: errorCode || data?.code || null,
        measure,
      };
      record(row);
      resolve({ status, data, headers, row });
    };
    const request = http.request(
      new URL(path, base),
      {
        method,
        agent,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          chunks.push(chunk);
        });
        response.on("end", () => {
          let data,
            parseError = null;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            data = null;
            parseError = "INVALID_JSON";
          }
          finish(
            response.statusCode || 0,
            data,
            bytes,
            parseError,
            response.headers,
          );
        });
        response.on("error", (error) =>
          finish(
            response.statusCode || 0,
            null,
            bytes,
            error.code || error.message,
          ),
        );
      },
    );
    request.setTimeout(config.requestTimeoutMs, () =>
      request.destroy(
        Object.assign(new Error("request timeout"), { code: "TIMEOUT" }),
      ),
    );
    request.on("error", (error) =>
      finish(0, null, 0, error.code || error.message),
    );
    if (payload) request.write(payload);
    request.end();
  });
}
async function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (data) => serverLog.write(data));
    proc.stderr.on("data", (data) => serverLog.write(data));
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function mark(content = "测试说明") {
  return { id: randomUUID(), x: 0.25, y: 0.3, content, sortOrder: 0 };
}
function saveBody(revision, operations) {
  return {
    submissionId: randomUUID(),
    baseRevision: revision,
    added: [],
    updated: [],
    deleted: [],
    ...operations,
  };
}
async function scenario(name, description, concurrency, work) {
  activeScenario = name;
  const first = rows.length,
    firstResource = resourceSamples.length,
    firstCheck = checks.length,
    start = performance.now();
  console.log(`START ${name} concurrency=${concurrency}`);
  const extra = await work(start);
  const elapsedMs = (extra?.measureEnd ?? performance.now()) - start;
  const data = rows.slice(first).filter((r) => r.measure !== false),
    httpRows = data.filter((r) => r.method !== "SSE");
  const byKind = {};
  for (const kind of new Set(data.map((r) => r.kind)))
    byKind[kind] = stats(
      data.filter((r) => r.kind === kind),
      elapsedMs,
    );
  const samples = resourceSamples.slice(firstResource);
  const result = {
    name,
    description,
    concurrency,
    elapsedMs,
    http: stats(httpRows, elapsedMs),
    byKind,
    checks: checks.slice(firstCheck),
    resources: {
      samples: samples.length,
      peakRssBytes: samples.length
        ? Math.max(...samples.map((s) => s.rssBytes))
        : null,
      cpuPercentMax: samples.length
        ? Math.max(...samples.map((s) => s.cpuPercent))
        : null,
      eventLoopDelayP95MsMax: samples.length
        ? Math.max(...samples.map((s) => s.eventLoopDelayP95Ms))
        : null,
      eventLoopDelayMaxMs: samples.length
        ? Math.max(...samples.map((s) => s.eventLoopDelayMaxMs))
        : null,
    },
    ...extra,
  };
  delete result.measureEnd;
  scenarios.push(result);
  console.log(
    `DONE ${name} requests=${result.http.requests} errors=${result.http.failed} p95=${result.http.latencyMs.p95?.toFixed(1)}ms rps=${result.http.rps.toFixed(1)}`,
  );
}
async function createFixtures() {
  const { openDb } = await import(
    new URL("../dist/apps/api/src/database.js", import.meta.url)
  );
  const { saveReview } = await import(
    new URL("../dist/apps/api/src/service.js", import.meta.url)
  );
  const db = openDb(dbFile),
    now = new Date().toISOString();
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  db.transaction(() => {
    for (let i = 0; i < config.accountCount; i++) {
      const id = `load-user-${i}`,
        name = `压测账号${i}`;
      db.prepare("INSERT INTO operators VALUES(?,?)").run(id, name);
      db.prepare("INSERT INTO accounts VALUES(?,?)").run(
        id,
        name.toLowerCase(),
      );
      db.prepare("INSERT INTO group_members VALUES(?,?,?)").run(
        "default-group",
        id,
        now,
      );
      accounts.push({ id, name });
    }
  })();
  function image(id, count = 10, length = 100, owner = accounts[0].id) {
    db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,0,?,?,?)").run(
      id,
      id,
      "image/png",
      png,
      10,
      10,
      owner,
      now,
      now,
    );
    db.prepare("INSERT INTO image_groups VALUES(?,?)").run(id, "default-group");
    const annotations = Array.from({ length: count }, (_, i) => ({
      ...mark("测".repeat(length)),
      sortOrder: i,
    }));
    const r = saveReview(db, id, {
      actorId: owner,
      baseRevision: 0,
      annotations,
    });
    images.set(id, r);
  }
  image("read-normal");
  image("read-maximum", 100, 500);
  image("warmup");
  for (const n of config.levels) {
    for (let i = 0; i < n; i++)
      image(`write-${n}-${i}`, 10, 100, accounts[i].id);
    image(`conflict-${n}`, 1, 100);
    image(`sse-${n}`, 10, 100);
  }
  const sqlite = db.prepare("SELECT sqlite_version() version").get().version;
  db.close();
  return sqlite;
}
async function startServer() {
  const port = await availablePort();
  base = `http://127.0.0.1:${port}`;
  child = fork(resolve(root, "dist/apps/api/src/server.js"), [], {
    cwd: directory,
    env: { ...process.env, PORT: String(port), DB_FILE: dbFile },
    execArgv: ["--import", resolve(root, "scripts/load-metrics.mjs")],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.on("data", (data) => serverLog.write(data));
  child.stderr.on("data", (data) => serverLog.write(data));
  child.on("message", (value) => {
    if (value?.type === "load-metrics") {
      const sample = { ...value, scenario: activeScenario };
      resourceSamples.push(sample);
      resourcesOut.write(JSON.stringify(sample) + "\n");
    }
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error("isolated server exited during startup");
    const result = await rpc("/api/health", { kind: "setup", measure: false });
    if (result.status === 200) return;
    await sleep(50);
  }
  throw new Error("server readiness timeout");
}
async function stopServer() {
  if (child && child.exitCode === null) {
    const done = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    await done;
    clearTimeout(timer);
  }
}
async function readStage(n, id, seconds) {
  await scenario(
    `read-${id}-${n}`,
    `闭环GET review；${images.get(id).annotations.length}条标记，每条${id === "read-maximum" ? 500 : 100}字；无思考时间`,
    n,
    async (start) => {
      let sent = 0,
        invalidResponses = 0;
      const deadline = start + seconds * 1000;
      await Promise.all(
        Array.from({ length: n }, async (_, worker) => {
          let failures = 0;
          while (
            performance.now() < deadline &&
            sent < config.maxReadRequestsPerStage &&
            child.exitCode === null
          ) {
            const iteration = sent++;
            const r = await rpc(`/api/images/${id}/review`, {
              cookie: accounts[worker % accounts.length].cookie,
              kind: "review-read",
              worker,
              iteration,
            });
            if (
              r.row.ok &&
              (r.data?.image?.id !== id ||
                r.data?.annotations?.length !==
                  images.get(id).annotations.length)
            )
              invalidResponses++;
            if (!r.row.ok) {
              if (++failures >= 10) break;
              await sleep(20);
            } else failures = 0;
          }
        }),
      );
      check("read-response-shape", invalidResponses === 0, {
        invalidResponses,
      });
      return {
        stopReason:
          sent >= config.maxReadRequestsPerStage ? "request-cap" : "duration",
        configuredSeconds: seconds,
      };
    },
  );
}
async function writeStage(n) {
  await scenario(
    `write-independent-${n}`,
    `每个worker编辑自己的图片，${config.writeIterations}次沿成功响应版本增量保存；每图10条标记`,
    n,
    async () => {
      const successes = Array(n).fill(0),
        last = Array(n).fill(null);
      await Promise.all(
        Array.from({ length: n }, async (_, worker) => {
          const id = `write-${n}-${worker}`,
            initial = images.get(id),
            a = initial.annotations[0];
          let revision = initial.image.revision;
          for (
            let iteration = 0;
            iteration < config.writeIterations;
            iteration++
          ) {
            const content =
              `worker${worker}修改${iteration}：` + "测".repeat(100);
            const r = await rpc(`/api/images/${id}/annotations`, {
              method: "PATCH",
              cookie: accounts[worker].cookie,
              kind: "annotation-write",
              worker,
              iteration,
              body: saveBody(revision, {
                updated: [{ id: a.id, x: a.x, y: a.y, content }],
              }),
            });
            if (r.status !== 200) break;
            revision = r.data.image.revision;
            successes[worker]++;
            last[worker] = content;
          }
        }),
      );
      const measureEnd = performance.now();
      for (let worker = 0; worker < n; worker++) {
        const r = await rpc(`/api/images/write-${n}-${worker}/review`, {
          cookie: accounts[worker].cookie,
          kind: "verification",
          measure: false,
        });
        check(
          `worker-${worker}-persisted`,
          r.status === 200 &&
            r.data.image.revision === 1 + successes[worker] &&
            r.data.annotations.length === 10 &&
            (!last[worker] || r.data.annotations[0].content === last[worker]),
          {
            acknowledged: successes[worker],
            revision: r.data?.image?.revision,
            count: r.data?.annotations?.length,
          },
        );
      }
      return {
        measureEnd,
        acknowledgedWrites: successes.reduce((a, b) => a + b, 0),
      };
    },
  );
}
async function conflictStage(n) {
  await scenario(
    `same-marker-${n}`,
    "所有账号从同一基准版本同时修改同一个标记，每人不同内容；检查分叉及版本",
    n,
    async () => {
      const id = `conflict-${n}`,
        initial = images.get(id),
        a = initial.annotations[0],
        expected = [];
      const results = await Promise.all(
        Array.from({ length: n }, async (_, worker) => {
          const content = `并发账号${worker}：` + "测".repeat(100);
          expected.push(content);
          return rpc(`/api/images/${id}/annotations`, {
            method: "PATCH",
            cookie: accounts[worker].cookie,
            kind: "concurrent-same-marker",
            worker,
            iteration: 0,
            body: saveBody(1, {
              updated: [{ id: a.id, x: a.x, y: a.y, content }],
            }),
          });
        }),
      );
      const measureEnd = performance.now(),
        r = await rpc(`/api/images/${id}/review`, {
          cookie: accounts[0].cookie,
          kind: "verification",
          measure: false,
        });
      check(
        "all-concurrent-writes-acknowledged",
        results.every((r) => r.status === 200),
        { statuses: results.map((r) => r.status) },
      );
      check(
        "all-distinct-contents-persisted",
        r.status === 200 &&
          r.data.annotations.length === n &&
          new Set(r.data.annotations.map((a) => a.id)).size === n &&
          JSON.stringify(r.data.annotations.map((a) => a.content).sort()) ===
            JSON.stringify(expected.sort()) &&
          r.data.image.revision === n + 1,
        {
          count: r.data?.annotations?.length,
          revision: r.data?.image?.revision,
          expected: n,
        },
      );
      return { measureEnd };
    },
  );
}
async function businessLimit() {
  if (!config.levels.includes(100)) return;
  await scenario(
    "business-limit-101",
    "业务保护对照：已有100份并发修改时再提交第101份，预期409 MERGE_LIMIT，不计为服务器容量故障",
    1,
    async () => {
      const a = images.get("conflict-100").annotations[0];
      const r = await rpc("/api/images/conflict-100/annotations", {
        method: "PATCH",
        cookie: accounts[0].cookie,
        kind: "expected-policy-rejection",
        body: saveBody(1, {
          updated: [
            { id: a.id, x: a.x, y: a.y, content: "第101份应被业务上限拒绝" },
          ],
        }),
      });
      const measureEnd = performance.now();
      const saved = await rpc("/api/images/conflict-100/review", {
        cookie: accounts[0].cookie,
        kind: "verification",
        measure: false,
      });
      check(
        "101st-change-rejected-atomically",
        r.status === 409 &&
          r.data?.code === "MERGE_LIMIT" &&
          saved.data?.annotations.length === 100 &&
          saved.data?.image.revision === 101,
        {
          status: r.status,
          code: r.data?.code,
          count: saved.data?.annotations.length,
          revision: saved.data?.image.revision,
        },
      );
      return { measureEnd, expectedPolicyRejection: true };
    },
  );
}
async function sseStage(n) {
  await scenario(
    `sse-fanout-${n}`,
    "N条SSE长连接；收到通知后50ms合并、串行GET图片列表及review，模拟当前页面补查（无浏览器渲染）",
    n,
    async () => {
      const id = `sse-${n}`,
        a = images.get(id).annotations[0],
        updates = new Map(),
        streams = [],
        inflight = new Set();
      let ended = false,
        disconnects = 0;
      function track(promise) {
        inflight.add(promise);
        promise.finally(() => inflight.delete(promise));
        return promise;
      }
      function observe(client, revision) {
        const complete = performance.now();
        for (const [savedRevision, update] of updates) {
          if (savedRevision <= revision && !client.covered.has(savedRevision)) {
            client.covered.add(savedRevision);
            record({
              kind: "sse-visible",
              worker: client.worker,
              startedAt: update.startedAt,
              method: "SSE",
              path: `/api/images/${id}/review`,
              status: 200,
              ok: true,
              latencyMs: complete - update.start,
              requestBytes: 0,
              responseBytes: 0,
              revision: savedRevision,
              observedRevision: revision,
            });
          }
        }
        client.lastRevision = Math.max(client.lastRevision, revision);
      }
      function schedule(client) {
        if (ended || client.busy || client.timer) return;
        client.timer = setTimeout(() => {
          client.timer = null;
          client.busy = true;
          const wanted = client.wanted;
          track(
            (async () => {
              await rpc("/api/images?groupId=default-group", {
                cookie: accounts[client.worker].cookie,
                kind: "sse-refresh-list",
                worker: client.worker,
              });
              const r = await rpc(`/api/images/${id}/review`, {
                cookie: accounts[client.worker].cookie,
                kind: "sse-refresh-review",
                worker: client.worker,
              });
              if (r.status === 200) observe(client, r.data.image.revision);
            })()
              .catch((error) => {
                check("sse-refresh-unhandled", false, error.message);
              })
              .finally(() => {
                client.busy = false;
                if (!ended && client.wanted > wanted) schedule(client);
              }),
          );
        }, 50);
      }
      const connectStart = performance.now();
      try {
        await Promise.all(
          Array.from(
            { length: n },
            (_, worker) =>
              new Promise((resolve, reject) => {
                const startedAt = new Date().toISOString(),
                  start = performance.now(),
                  client = {
                    worker,
                    covered: new Set(),
                    seen: new Set(),
                    lastRevision: 1,
                    wanted: 1,
                    timer: null,
                    busy: false,
                  };
                streams.push(client);
                const deadline = setTimeout(() => {
                  client.request?.destroy();
                  reject(new Error("SSE ready timeout"));
                }, 12000);
                const request = (client.request = http.get(
                  new URL(
                    `/api/groups/default-group/events?owner=${accounts[worker].id}`,
                    base,
                  ),
                  {
                    agent: false,
                    headers: { Cookie: accounts[worker].cookie },
                  },
                  (response) => {
                    client.response = response;
                    if (response.statusCode !== 200) {
                      clearTimeout(deadline);
                      response.resume();
                      reject(new Error(`SSE HTTP ${response.statusCode}`));
                      return;
                    }
                    let buffer = "";
                    response.setEncoding("utf8");
                    response.on("data", (data) => {
                      buffer += data;
                      let index;
                      while ((index = buffer.indexOf("\n\n")) >= 0) {
                        const block = buffer.slice(0, index);
                        buffer = buffer.slice(index + 2);
                        const type = /^event: (.+)$/m.exec(block)?.[1],
                          raw = /^data: (.+)$/m.exec(block)?.[1];
                        if (!type || !raw) continue;
                        const event = JSON.parse(raw);
                        if (type === "ready") {
                          clearTimeout(deadline);
                          record({
                            kind: "sse-connect",
                            worker,
                            startedAt,
                            method: "SSE",
                            path: "/api/groups/default-group/events",
                            status: 200,
                            ok: true,
                            latencyMs: performance.now() - start,
                            requestBytes: 0,
                            responseBytes: 0,
                          });
                          resolve(client);
                        }
                        if (
                          type === "change" &&
                          event.type === "review" &&
                          event.imageId === id
                        ) {
                          const update = updates.get(event.revision);
                          if (update && !client.seen.has(event.revision)) {
                            client.seen.add(event.revision);
                            record({
                              kind: "sse-notification",
                              worker,
                              startedAt: update.startedAt,
                              method: "SSE",
                              path: "/api/groups/default-group/events",
                              status: 200,
                              ok: true,
                              latencyMs: performance.now() - update.start,
                              requestBytes: 0,
                              responseBytes: Buffer.byteLength(raw),
                              revision: event.revision,
                            });
                          }
                          client.wanted = Math.max(
                            client.wanted,
                            event.revision,
                          );
                          schedule(client);
                        }
                      }
                    });
                    response.on("error", () => {
                      if (!ended) disconnects++;
                    });
                    response.on("end", () => {
                      if (!ended) disconnects++;
                    });
                  },
                ));
                request.on("error", (error) => {
                  clearTimeout(deadline);
                  if (!ended) {
                    disconnects++;
                    reject(error);
                  }
                });
              }),
          ),
        );
        const connectedAt = performance.now();
        for (let iteration = 0; iteration < config.sseUpdates; iteration++) {
          const revision = iteration + 2,
            start = performance.now(),
            startedAt = new Date().toISOString();
          updates.set(revision, { start, startedAt });
          const r = await rpc(`/api/images/${id}/annotations`, {
            method: "PATCH",
            cookie: accounts[0].cookie,
            kind: "sse-origin-write",
            iteration,
            body: saveBody(revision - 1, {
              updated: [
                {
                  id: a.id,
                  x: a.x,
                  y: a.y,
                  content: `推送第${iteration}轮：` + "测".repeat(100),
                },
              ],
            }),
          });
          if (r.status !== 200) {
            check("sse-origin-save", false, { iteration, status: r.status });
            break;
          }
          await sleep(
            Math.max(0, config.sseIntervalMs - (performance.now() - start)),
          );
        }
        const targetRevision = config.sseUpdates + 1,
          deadline = performance.now() + 20000;
        while (
          performance.now() < deadline &&
          streams.some(
            (client) =>
              client.lastRevision < targetRevision ||
              client.seen.size < config.sseUpdates,
          )
        )
          await sleep(25);
        const finalCaughtUp = streams.filter(
            (client) => client.lastRevision >= targetRevision,
          ).length,
          receivedNotifications = streams.reduce(
            (n, client) => n + client.seen.size,
            0,
          );
        check(
          "all-notifications-received",
          receivedNotifications === n * config.sseUpdates,
          { expected: n * config.sseUpdates, received: receivedNotifications },
        );
        check("all-subscribers-caught-up", finalCaughtUp === n, {
          expected: n,
          finalCaughtUp,
          targetRevision,
        });
        check("no-unexpected-sse-disconnects", disconnects === 0, {
          disconnects,
        });
        const notificationRows = rows.filter(
            (r) =>
              r.scenario === activeScenario && r.kind === "sse-notification",
          ),
          visibleRows = rows.filter(
            (r) => r.scenario === activeScenario && r.kind === "sse-visible",
          );
        return {
          sse: {
            connections: n,
            updates: config.sseUpdates,
            expectedNotifications: n * config.sseUpdates,
            receivedNotifications,
            finalCaughtUp,
            disconnects,
            connectElapsedMs: connectedAt - connectStart,
            notificationLatencyMs: latency(
              notificationRows.map((r) => r.latencyMs),
            ),
            visibleLatencyMs: latency(visibleRows.map((r) => r.latencyMs)),
            coalescedUpdates: visibleRows.filter(
              (r) => r.observedRevision > r.revision,
            ).length,
          },
        };
      } finally {
        ended = true;
        for (const client of streams) {
          if (client.timer) clearTimeout(client.timer);
          client.request?.destroy();
        }
        await Promise.allSettled([...inflight]);
      }
    },
  );
}
let sqliteVersion = null;
try {
  await runCommand("npm", ["run", "build"]);
  sqliteVersion = await createFixtures();
  await startServer();
  for (const account of accounts) {
    const r = await rpc("/api/auth/login", {
      method: "POST",
      body: { name: account.name },
      kind: "setup",
      measure: false,
    });
    if (r.status !== 200) throw new Error("synthetic account login failed");
    account.cookie = r.headers["set-cookie"][0].split(";")[0];
  }
  // Warm routes/JIT/pools outside measured scenarios.
  for (let i = 0; i < 20; i++) {
    await rpc("/api/images/read-normal/review", {
      cookie: accounts[0].cookie,
      kind: "warmup",
      measure: false,
    });
    const a = images.get("warmup").annotations[0];
    await rpc("/api/images/warmup/annotations", {
      method: "PATCH",
      cookie: accounts[0].cookie,
      kind: "warmup",
      measure: false,
      body: saveBody(i + 1, {
        updated: [{ id: a.id, x: a.x, y: a.y, content: `预热${i}` }],
      }),
    });
  }
  for (const n of config.levels)
    await readStage(n, "read-normal", config.readSeconds);
  await readStage(
    Math.max(...config.levels),
    "read-maximum",
    Math.min(5, config.readSeconds),
  );
  for (const n of config.levels) await writeStage(n);
  for (const n of config.levels) await conflictStage(n);
  await businessLimit();
  for (const n of config.levels) await sseStage(n);
} catch (error) {
  fatal = { message: error.message, stack: error.stack };
  check("harness-completed", false, error.message);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  activeScenario = "shutdown";
  await stopServer();
  agent.destroy();
  try {
    const db = new Database(dbFile);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const integrity = db.pragma("integrity_check", { simple: true });
    check("sqlite-integrity-check", integrity === "ok", integrity);
    const counts = {};
    for (const table of [
      "images",
      "annotations",
      "review_versions",
      "review_submissions",
    ])
      counts[table] = db
        .prepare(`SELECT count(*) count FROM ${table}`)
        .get().count;
    db.close();
    await pipeline(
      createReadStream(dbFile),
      createGzip(),
      createWriteStream(join(output, "fixture.sqlite.gz")),
    );
    await writeFile(
      join(output, "database-info.json"),
      JSON.stringify(
        {
          fileBytes: (await stat(dbFile)).size,
          compressedBytes: (await stat(join(output, "fixture.sqlite.gz"))).size,
          counts,
          integrity,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    check("database-archive", false, error.message);
  }
  const summary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      platform: platform() + " " + release(),
      arch: arch(),
      node: process.version,
      sqlite: sqliteVersion,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      totalMemoryBytes: totalmem(),
      serverPid: child?.pid,
      scope:
        "同机loopback；独立生产构建子进程与临时磁盘SQLite；纯HTTP/SSE模拟账号，无浏览器渲染",
    },
    configuration: config,
    scenarios,
    checks,
    fatal,
    artifacts: {
      requests: "requests.jsonl",
      csv: "requests.csv",
      resources: "resources.jsonl",
      serverLog: "server-output.txt",
      database: "fixture.sqlite.gz",
      databaseInfo: "database-info.json",
    },
    limitations: [
      "并发数为闭环HTTP worker或SSE连接，不代表真实浏览器用户数。",
      "客户端与服务端同机竞争CPU，loopback不含公网延迟；这些结果不是最大用户容量或生产SLA。",
      "HTTP延迟包括客户端队列、传输、响应读取与JSON解析；不包括浏览器绘制。百分位按全部已完成请求计算，错误另列。",
      "SSE可见延迟从保存请求开始计时，包含50ms合并及list+review补查；较新版本覆盖较旧通知时记为已追赶，而非每个中间版本都曾显示。",
      "读取阶段限时且最多20000请求，耗时包括停止发起后的在途请求收尾；写入阶段为固定操作次数突发测试，未模拟用户思考时间。",
      "HTTP RPS只包含测量请求；初始化、预热、验证查询不计入。业务上限101保护阶段预期409应单列，不是性能错误。",
      "未覆盖上传解码、大图片下载、真实浏览器内存/渲染、长时间耐久测试、多服务器部署。",
      "资源指标每秒采样，极短阶段可能没有样本；event-loop histogram分辨率10ms，不是完整CPU剖析。",
    ],
  };
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  await writeFile(
    resolve(root, "docs/verification/load-test/latest.json"),
    JSON.stringify({ runId, path: runId + "/summary.json" }, null, 2) + "\n",
  );
  try {
    await runCommand("python3", [
      resolve(root, "scripts/render-load-report.py"),
      join(output, "summary.json"),
    ]);
  } catch (error) {
    console.warn(
      "HTML报告未生成；原始JSON/CSV已保存。可安装Python3后运行render-load-report.py：",
      error.message,
    );
  }
  await Promise.all(
    [raw, csv, resourcesOut, serverLog].map(
      (stream) =>
        new Promise((resolve, reject) => {
          stream.on("error", reject);
          stream.end(resolve);
        }),
    ),
  );
  await rm(directory, { recursive: true, force: true });
  if (checks.some((c) => !c.passed)) process.exitCode = 1;
  console.log(`RESULTS ${output}`);
  console.log(
    `CHECKS ${checks.filter((c) => c.passed).length}/${checks.length}`,
  );
}
