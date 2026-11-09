/** One animation frame while the map side panel is open. `t` is milliseconds since it opened. */
export type MapSettleFrame = {
  t: number;
  stage: number | null;
  svg: number | null;
  svgH: number | null;
  layer: number | null;
  content: number | null;
};

/**
 * Layout settle check.
 *
 * The old `frames.length > 60` gate required about 40fps across a 1500ms
 * watch. That count is display timing, not geometry: a 2 vCPU runner
 * delivered 55 frames in the same window and failed before the width,
 * alternation, and overflow checks. Those geometry rules are unchanged.
 * The sample must still cover the watch window, and it must be dense
 * enough (about one frame per 100ms) that a later shift is visible.
 */
export function mapSettleProblems(frames: MapSettleFrame[], durationMs: number): string[] {
  const problems: string[] = [];
  const last = frames[frames.length - 1];
  if (!last || frames.length < 2) {
    problems.push(`frames with the panel open: ${frames.length}`);
    return problems;
  }
  if (last.t < durationMs - 50) problems.push(`panel-open window ended at ${last.t}ms before ${durationMs}ms`);
  const minimumFrames = Math.max(2, Math.floor(last.t / 100));
  if (frames.length <= minimumFrames) problems.push(`only ${frames.length} frames across ${last.t}ms`);

  const stageWidths = new Set(frames.map((frame) => frame.stage));
  const svgWidths = new Set(frames.map((frame) => frame.svg));
  if (stageWidths.size > 2) problems.push(`stage widths ${[...stageWidths].join(",")}`);
  if (svgWidths.size > 2) problems.push(`canvas widths ${[...svgWidths].join(",")}`);
  const late = frames.filter((frame) => frame.t >= 300);
  const key = (frame: MapSettleFrame) => `${frame.stage}|${frame.svg}|${frame.svgH}`;
  const changes = late.slice(1).filter((frame, index) => key(frame) !== key(late[index])).length;
  if (changes !== 0) problems.push(`${changes} alternations after 300ms`);
  if (last.layer != null && last.content != null) {
    const overflow = last.layer - last.content;
    if (!(overflow <= 0.01 || overflow >= 1)) problems.push(`sub-pixel overflow ${overflow}`);
  }
  return problems;
}
