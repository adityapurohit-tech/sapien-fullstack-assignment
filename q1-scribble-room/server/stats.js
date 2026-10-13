import { monitorEventLoopDelay } from 'node:perf_hooks';

// Counters read by /api/metrics and by the load test.
export const stats = { msgIn: 0, msgOut: 0, bytesOut: 0, violations: 0, dropped: 0 };

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

let lastCpu = process.cpuUsage();
let lastT = Date.now();
let lastIn = 0, lastOut = 0;

export function snapshotMetrics(extra = {}) {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  const dt = Math.max(1, now - lastT);
  const out = {
    cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / dt) * 1000) / 10,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    loopDelayP50ms: +(loop.percentile(50) / 1e6).toFixed(2),
    loopDelayP99ms: +(loop.percentile(99) / 1e6).toFixed(2),
    loopDelayMaxms: +(loop.max / 1e6).toFixed(2),
    msgInPerSec: Math.round(((stats.msgIn - lastIn) * 1000) / dt),
    msgOutPerSec: Math.round(((stats.msgOut - lastOut) * 1000) / dt),
    violations: stats.violations,
    ...extra,
  };
  lastCpu = process.cpuUsage();
  lastT = now;
  lastIn = stats.msgIn;
  lastOut = stats.msgOut;
  loop.reset();
  return out;
}
