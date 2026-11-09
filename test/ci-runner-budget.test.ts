import assert from "node:assert/strict";
import test from "node:test";
import { clickLatencyBudgetMs, stressTestTimeoutMs } from "../lib/ci-runner-budget";
import { mapSettleProblems, type MapSettleFrame } from "../lib/map-frame-settle";

function frames(count: number, durationMs: number, mutate?: (frame: MapSettleFrame, index: number) => void): MapSettleFrame[] {
  return Array.from({ length: count }, (_, index) => {
    const frame: MapSettleFrame = {
      t: count === 1 ? 0 : (durationMs * index) / (count - 1),
      stage: 800,
      svg: 800,
      svgH: 600,
      layer: 800,
      content: 800,
    };
    mutate?.(frame, index);
    return frame;
  });
}

test("slow runner budgets stay at the local defaults unless the flag is set", () => {
  assert.equal(clickLatencyBudgetMs({}), 500);
  assert.equal(stressTestTimeoutMs({}), 600_000);
  assert.equal(clickLatencyBudgetMs({ AEGIS_CI_SLOW_RUNNER: "1" }), 2_000);
  assert.equal(stressTestTimeoutMs({ AEGIS_CI_SLOW_RUNNER: "1" }), 2_400_000);
  assert.equal(clickLatencyBudgetMs({ AEGIS_CI_SLOW_RUNNER: "0" }), 500);
});

test("55 frames in the 1500ms watch pass when geometry is stable", () => {
  const sample = frames(55, 1500);
  sample[0].stage = 760;
  sample[0].svg = 760;
  assert.deepEqual(mapSettleProblems(sample, 1500), []);
});

test("a shifted panel after 300ms still fails the same geometry rule", () => {
  const sample = frames(90, 1500, (frame) => {
    if (frame.t >= 400) frame.stage = 640;
  });
  const problems = mapSettleProblems(sample, 1500);
  assert.equal(problems.some((problem) => problem.includes("alternations after 300ms")), true);
  assert.equal(problems.some((problem) => problem.startsWith("only ")), false);
});

test("a short watch does not pass just because the runner was slow", () => {
  const problems = mapSettleProblems(frames(55, 800), 1500);
  assert.match(problems.join("\n"), /before 1500ms/);
});

test("two frames across the full watch are too sparse to hide a later shift", () => {
  const problems = mapSettleProblems(frames(2, 1500), 1500);
  assert.match(problems.join("\n"), /only 2 frames/);
});
