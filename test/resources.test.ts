import assert from "node:assert/strict";
import test from "node:test";
import { ResourceSampler, type ResourceReading } from "../resources.ts";

function cpu(user = 0, idle = 0, sys = 0, nice = 0, irq = 0) {
  return { times: { user, nice, sys, idle, irq } };
}

function reading(counters = [cpu()], overrides: Partial<ResourceReading> = {}): ResourceReading {
  return { host: "test-host", cpus: counters, memoryFreeBytes: 250, memoryTotalBytes: 1000, ...overrides };
}

test("CPU requires two samples; memory is total minus free including caches", () => {
  const samples = [reading([cpu(10, 80, 10)]), reading([cpu(30, 150, 20)])];
  const sampler = new ResourceSampler(() => samples.shift()!);
  const first = sampler.sample();
  assert.equal(first.cpuRatio, null);
  assert.equal(first.host, "test-host");
  assert.equal(first.memoryTotalBytes, 1000);
  assert.equal(first.memoryUsedBytes, 750);
  assert.deepEqual(first.cpuHistory, [null]);
  assert.deepEqual(first.memoryHistory, [0.75]);
  const next = sampler.sample();
  assert.equal(next.cpuRatio, 0.3);
  assert.deepEqual(next.cpuHistory, [null, 0.3]);
});

test("multi-core utilization is weighted by total counter deltas", () => {
  const samples = [reading([cpu(), cpu()]), reading([cpu(50, 50), cpu(60, 140)])];
  const sampler = new ResourceSampler(() => samples.shift()!);
  sampler.sample();
  assert.equal(sampler.sample().cpuRatio, 110 / 300);
});

test("counter rollback, no elapsed CPU time and core-count changes are unavailable", () => {
  const samples = [
    reading([cpu(50, 50)]),
    reading([cpu(40, 150)]), // User counter reset despite a larger aggregate.
    reading([cpu(50, 160)]),
    reading([cpu(50, 160)]),
    reading([cpu(60, 170), cpu(50, 100)]),
    reading([cpu(60, 180), cpu(50, 110)]),
  ];
  const sampler = new ResourceSampler(() => samples.shift()!);
  assert.equal(sampler.sample().cpuRatio, null);
  assert.equal(sampler.sample().cpuRatio, null);
  assert.equal(sampler.sample().cpuRatio, 0.5);
  assert.equal(sampler.sample().cpuRatio, null);
  assert.equal(sampler.sample().cpuRatio, null);
  assert.equal(sampler.sample().cpuRatio, 0);
});

test("invalid readings and reader errors clear CPU baseline without leaking stale values", () => {
  const samples: (() => ResourceReading)[] = [
    () => reading([cpu(1, 2)]),
    () => { throw new Error("unavailable"); },
    () => reading([cpu(3, 4)]),
    () => reading([]),
    () => reading([cpu(4, 5)]),
    () => reading([cpu(Number.NaN, 6)]),
    () => reading([cpu(5, 7)]),
    () => reading([cpu(6, 8)], { host: "\u001b[31mmalicious" }),
  ];
  const sampler = new ResourceSampler(() => samples.shift()!());
  for (let i = 0; i < 7; i += 1) assert.equal(sampler.sample().cpuRatio, null);
  const recovered = sampler.sample();
  assert.equal(recovered.cpuRatio, 0.5);
  assert.equal(recovered.host, "test-host");
});

test("memory reports invalid values as unavailable while preserving a known total", () => {
  for (const memoryFreeBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1001, 0.5]) {
    const snapshot = new ResourceSampler(() => reading([], { memoryFreeBytes })).sample();
    assert.equal(snapshot.memoryUsedBytes, null);
    assert.equal(snapshot.memoryTotalBytes, 1000);
    assert.deepEqual(snapshot.memoryHistory, [null]);
  }
  for (const memoryTotalBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const snapshot = new ResourceSampler(() => reading([], { memoryTotalBytes })).sample();
    assert.equal(snapshot.memoryUsedBytes, null);
    assert.equal(snapshot.memoryTotalBytes, null);
  }
  assert.equal(new ResourceSampler(() => reading([], { memoryFreeBytes: 1000 })).sample().memoryUsedBytes, 0);
});

test("histories are bounded, isolated from callers, and reset with the baseline", () => {
  let step = 0;
  const sampler = new ResourceSampler(() => reading([cpu(step, 3 * step++)]));
  for (let i = 0; i < 40; i += 1) sampler.sample();
  const snapshot = sampler.sample();
  assert.equal(snapshot.cpuHistory.length, 32);
  assert.equal(snapshot.memoryHistory.length, 32);
  assert.ok(snapshot.cpuHistory.every(value => value === 0.25));
  const mutableCpuHistory: (number | null)[] = snapshot.cpuHistory;
  const mutableMemoryHistory: (number | null)[] = snapshot.memoryHistory;
  mutableCpuHistory[0] = 999;
  mutableMemoryHistory[0] = 999;
  const next = sampler.sample();
  assert.equal(next.cpuHistory[0], 0.25);
  assert.equal(next.memoryHistory[0], 0.75);
  sampler.reset();
  const reset = sampler.sample();
  assert.equal(reset.cpuRatio, null);
  assert.deepEqual(reset.cpuHistory, [null]);
  assert.deepEqual(reset.memoryHistory, [0.75]);
});

test("CPU baselines copy counters when a reader reuses mutable objects", () => {
  const same = reading([cpu(10, 90)]);
  const sampler = new ResourceSampler(() => same);
  sampler.sample();
  same.cpus[0].times.user += 20;
  same.cpus[0].times.idle += 80;
  assert.equal(sampler.sample().cpuRatio, 0.2);
});
