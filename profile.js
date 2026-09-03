// Counters and timers for the tracer's own work. Every call is a no-op unless
// PROOT_BUN_PROFILE=1, so the instrumentation can stay on the hot paths.
import { profile } from "./env.js";

const counts = new Map(), timings = new Map();

export function count(name, amount = 1) {
  if (!profile) return;
  counts.set(name, (counts.get(name) ?? 0) + amount);
}

export function timed(name, work) {
  if (!profile) return work();
  const start = performance.now();
  try { return work(); }
  finally { timings.set(name, (timings.get(name) ?? 0) + (performance.now() - start)); }
}

export function report(elapsed) {
  if (!profile) return;
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  console.error(`[profile] wall ${elapsed.toFixed(0)}ms`);
  for (const [name, value] of rows) console.error(`[profile] ${name} ${value}`);
  for (const [name, value] of [...timings].sort((a, b) => b[1] - a[1]))
    console.error(`[profile] ${name} ${value.toFixed(0)}ms (${(100 * value / elapsed).toFixed(1)}%)`);
}
