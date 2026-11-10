import assert from "node:assert/strict";
import test from "node:test";
import { RequestMetrics } from "../metrics.ts";

test("completed request keeps usage components distinct and measures first content to completion", () => {
  const metrics = new RequestMetrics();
  metrics.begin(1000, "provider-request");
  metrics.firstDelta(3500, "text", "first chunk");
  metrics.firstDelta(4000, "text", "second chunk");
  metrics.finish(6000, { input: 120, cacheRead: 800, cacheWrite: 80, output: 100 });
  const result = metrics.snapshot();
  assert.equal(result.source, "provider-request");
  assert.equal(result.measurement, "client-observed");
  assert.equal(result.inputTokens, 120);
  assert.equal(result.cacheReadTokens, 800);
  assert.equal(result.cacheWriteTokens, 80);
  assert.equal(result.contextUsedTokens, 1000);
  assert.equal(result.cacheHitRate, .8);
  assert.equal(result.ttftMs, 2500);
  assert.equal(result.generationMs, 2500);
  assert.equal(result.tokensPerSecond, 40);
  assert.equal(result.elapsedMs, 5000);
});

test("waiting or streaming never fabricates a live token rate", () => {
  const metrics = new RequestMetrics();
  metrics.begin(10);
  metrics.firstDelta(20, "text", "");
  let result = metrics.snapshot(100);
  assert.equal(result.phase, "waiting");
  assert.equal(result.ttftMs, null);
  assert.equal(result.tokensPerSecond, null);
  assert.equal(result.elapsedMs, 90);
  metrics.firstDelta(110, "thinking", "thinking content");
  result = metrics.snapshot(510);
  assert.equal(result.phase, "streaming");
  assert.equal(result.firstDeltaKind, "thinking");
  assert.equal(result.ttftMs, 100);
  assert.equal(result.tokensPerSecond, null);
});

test("tool-call argument deltas count as first model output and are never retained", () => {
  const metrics = new RequestMetrics();
  metrics.begin(0);
  metrics.firstDelta(250, "toolcall", "PRIVATE TOOL ARGUMENT");
  metrics.firstDelta(500, "text", "PRIVATE ANSWER");
  metrics.finish(1250, { output: 25 });
  const result = metrics.snapshot();
  assert.equal(result.ttftMs, 250);
  assert.equal(result.tokensPerSecond, 25);
  assert.equal(result.firstDeltaKind, "toolcall");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("new requests and session resets do not carry successful measurements forward", () => {
  const metrics = new RequestMetrics();
  metrics.begin(100);
  metrics.firstDelta(200, "text", "done");
  metrics.finish(1200, { input: 100, cacheRead: 200, output: 50 });
  metrics.begin(2000);
  let result = metrics.snapshot(2500);
  assert.equal(result.phase, "waiting");
  assert.equal(result.ttftMs, null);
  assert.equal(result.tokensPerSecond, null);
  assert.equal(result.cacheHitRate, null);
  assert.equal(result.inputTokens, null);
  metrics.reset();
  result = metrics.snapshot();
  assert.equal(result.phase, "idle");
  assert.equal(result.source, null);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.contextUsedTokens, null);
});

test("failed and aborted requests do not display success timing", () => {
  for (const outcome of ["error", "aborted"] as const) {
    const metrics = new RequestMetrics();
    metrics.begin(100);
    metrics.firstDelta(200, "text", "partial");
    metrics.finish(1000, { output: 5 }, outcome);
    const result = metrics.snapshot();
    assert.equal(result.phase, outcome);
    assert.equal(result.ttftMs, null);
    assert.equal(result.generationMs, null);
    assert.equal(result.tokensPerSecond, null);
    assert.equal(result.outputTokens, 5);
  }
});

test("missing output, missing deltas and zero generation duration have unknown throughput", () => {
  const metrics = new RequestMetrics();
  metrics.begin(100);
  metrics.finish(500, { output: 10 });
  assert.equal(metrics.snapshot().ttftMs, null);
  assert.equal(metrics.snapshot().tokensPerSecond, null);
  metrics.begin(1000);
  metrics.firstDelta(1100, "text", "x");
  metrics.finish(1100, { output: 10 });
  assert.equal(metrics.snapshot().generationMs, 0);
  assert.equal(metrics.snapshot().tokensPerSecond, null);
  metrics.begin(2000);
  metrics.firstDelta(2100, "text", "x");
  metrics.finish(3100, {});
  assert.equal(metrics.snapshot().outputTokens, null);
  assert.equal(metrics.snapshot().tokensPerSecond, null);
});

test("reported zero output and cache misses stay zero while zero denominator stays unknown", () => {
  const metrics = new RequestMetrics();
  metrics.begin(100);
  metrics.firstDelta(200, "text", "x");
  metrics.finish(1200, { input: 20, cacheRead: 0, cacheWrite: 0, output: 0 });
  assert.equal(metrics.snapshot().tokensPerSecond, 0);
  assert.equal(metrics.snapshot().cacheHitRate, 0);
  metrics.begin(2000);
  metrics.finish(3000, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  assert.equal(metrics.snapshot().contextUsedTokens, 0);
  assert.equal(metrics.snapshot().cacheHitRate, null);
});

test("missing input parts can be absent, but explicit invalid values never understate occupancy", () => {
  const metrics = new RequestMetrics();
  metrics.begin(0);
  metrics.finish(10, { input: 10 });
  assert.equal(metrics.snapshot().contextUsedTokens, 10);
  assert.equal(metrics.snapshot().cacheHitRate, null);
  for (const bad of [null, -1, NaN, Infinity, "12"]) {
    metrics.begin(20);
    metrics.finish(30, { input: 10, cacheRead: 50, cacheWrite: bad });
    const result = metrics.snapshot();
    assert.equal(result.cacheWriteTokens, null);
    assert.equal(result.contextUsedTokens, null);
    assert.equal(result.cacheHitRate, null);
  }
  metrics.begin(40);
  metrics.finish(50, { output: 10 });
  assert.equal(metrics.snapshot().contextUsedTokens, null);
});

test("clock regressions and invalid first timestamps stay unavailable", () => {
  const metrics = new RequestMetrics();
  metrics.begin(100);
  metrics.firstDelta(90, "text", "first");
  metrics.firstDelta(150, "text", "second");
  metrics.finish(250, { output: 20 });
  assert.equal(metrics.snapshot().ttftMs, null);
  assert.equal(metrics.snapshot().tokensPerSecond, null);
  metrics.begin(1000);
  metrics.firstDelta(1100, "text", "first");
  metrics.finish(1050, { output: 20 });
  assert.equal(metrics.snapshot().elapsedMs, null);
  assert.equal(metrics.snapshot().generationMs, null);
  assert.equal(metrics.snapshot().tokensPerSecond, null);
  metrics.begin(NaN);
  metrics.firstDelta(10, "text", "x");
  metrics.finish(20, { output: 10 });
  assert.equal(metrics.snapshot().ttftMs, null);
  assert.equal(metrics.snapshot().elapsedMs, null);
});

test("overflowing totals, invalid output and repeated finish do not create invented rates", () => {
  const metrics = new RequestMetrics();
  metrics.firstDelta(100, "text", "no request");
  metrics.finish(200, { output: 100 });
  assert.equal(metrics.snapshot().phase, "idle");
  metrics.begin(1000);
  metrics.firstDelta(1100, "text", "first");
  metrics.finish(2100, { input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, output: NaN });
  assert.equal(metrics.snapshot().contextUsedTokens, null);
  assert.equal(metrics.snapshot().outputTokens, null);
  assert.equal(metrics.snapshot().tokensPerSecond, null);
  const completed = metrics.snapshot();
  metrics.finish(2500, { output: 10 }, "error");
  assert.deepEqual(metrics.snapshot(), completed);
});
