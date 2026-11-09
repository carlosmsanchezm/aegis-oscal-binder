/** Visible family perimeter in unscaled map coordinates. The header stays inside it. */
export function familyViewport(
  lane: { x: number; y: number; w: number; h: number; headerH: number },
  viewport: { left: number; top: number; width: number; height: number },
) {
  const left = Math.max(lane.x, viewport.left),
    right = Math.min(lane.x + lane.w, viewport.left + viewport.width);
  const top = Math.max(lane.y, viewport.top),
    bottom = Math.min(lane.y + lane.h, viewport.top + viewport.height);
  const headerH = Math.min(lane.headerH + 24, lane.h);
  return {
    left,
    right,
    top,
    bottom,
    visible: right > left && bottom > top,
    headerTop: Math.min(
      Math.max(lane.y, viewport.top),
      lane.y + lane.h - headerH,
    ),
    headerH,
    cutTop: lane.y < viewport.top,
    cutBottom: lane.y + lane.h > viewport.top + viewport.height,
    cutLeft: lane.x < viewport.left,
    cutRight: lane.x + lane.w > viewport.left + viewport.width,
  };
}
