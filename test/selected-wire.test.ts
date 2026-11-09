import assert from "node:assert/strict";
import test from "node:test";
import { SELECTED_WIRE, styleSelectedWires } from "../lib/aegis/selected-wire";

test("lines from the selected control share one stroke", () => {
  const wires = styleSelectedWires([
    { rel: "related", from: "CM-6", to: "AC-2", glyph: "mutual", width: 2.5, opacity: 1, dash: "5 3" },
    { rel: "related", from: "CM-6", to: "AC-3", glyph: "outbound", width: 1.25, opacity: 1, dash: "5 3" },
    { rel: "related", from: "CM-6", to: "AC-6", glyph: "outbound", width: 2, opacity: 1, proposed: true },
    { rel: "evidence", from: "CM-6", to: "configuration.json", width: 1.9, opacity: 0.9 },
    { rel: "role", from: "system-owner", to: "CM-6", width: 1.25, opacity: 0.22 },
    { rel: "evidence", from: "AC-2", to: "other.json", width: 1.75, opacity: 0.9 },
    { rel: "missing", from: "CM-6", to: "role", width: 1.25, opacity: 0.9, dash: "1.2 2.2" },
  ], "CM-6");
  const selected = wires.filter((wire) => wire.selected);
  assert.equal(selected.length, 6);
  for (const wire of selected) {
    assert.equal(wire.width, SELECTED_WIRE.width);
    assert.equal(wire.linecap, "round");
    assert.equal(wire.markerEnd, true);
    assert.equal(wire.markerStart, false);
    assert.notEqual(wire.dash, "1.2 2.2");
  }
  assert.equal(wires[0].dash, undefined);
  assert.equal(wires[1].dash, undefined);
  assert.equal(wires[2].dash, "5 3");
  assert.equal(wires[3].stroke, SELECTED_WIRE.colors.evidence);
  assert.equal(wires[4].stroke, SELECTED_WIRE.colors.role);
  assert.equal(wires[5].selected, false);
  assert.equal(wires[5].width, 1);
  assert.equal(wires[5].opacity, 0.25);
  assert.equal(wires[6].dash, undefined);
  assert.equal(wires[6].stroke, SELECTED_WIRE.colors.missing);
});

test("no selection leaves wire width and opacity alone", () => {
  const [wire] = styleSelectedWires([{ rel: "related", from: "AC-2", to: "AC-3", width: 2.5, opacity: 1, dash: "5 3" }], null);
  assert.equal(wire.selected, false);
  assert.equal(wire.width, 2.5);
  assert.equal(wire.opacity, 1);
  assert.equal(wire.dash, "5 3");
});
