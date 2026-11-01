// Loaded only by the isolated pressure-test server, never by normal startup.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let previousCpu = process.cpuUsage(),
  previousTime = performance.now();
const timer = setInterval(() => {
  const now = performance.now(),
    cpu = process.cpuUsage(previousCpu),
    memory = process.memoryUsage();
  previousCpu = process.cpuUsage();
  process.send?.({
    type: "load-metrics",
    timestamp: new Date().toISOString(),
    cpuPercent: ((cpu.user + cpu.system) / ((now - previousTime) * 1000)) * 100,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopDelayP95Ms: delay.percentile(95) / 1e6,
    eventLoopDelayMaxMs: delay.max / 1e6,
  });
  previousTime = now;
  delay.reset();
}, 1000);
timer.unref();
