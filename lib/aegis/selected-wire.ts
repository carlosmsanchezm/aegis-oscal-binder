/** One stroke for every line that leaves the selected control. Color carries the meaning. */

export const SELECTED_WIRE = {
  width: 2,
  linecap: "round" as const,
  dash: "5 3",
  unselectedWidth: 1,
  unselectedOpacity: 0.25,
  marker: 7,
  colors: {
    evidence: "#168780",
    related: "#d99a00",
    role: "#6a4cff",
    missing: "#e8264f",
  },
} as const;

export type SelectedWireInput = {
  rel: string;
  from?: string;
  to?: string;
  glyph?: string;
  width: number;
  opacity: number;
  dash?: string;
  stroke?: string;
  markerEnd?: boolean;
  markerStart?: boolean;
  /** Pending artifact mapping. Dash is reserved for this state. */
  proposed?: boolean;
};

export type SelectedWire = SelectedWireInput & {
  selected: boolean;
  linecap: "round";
};

function touchesSelection(wire: SelectedWireInput, selectedId: string): boolean {
  return wire.from === selectedId || wire.to === selectedId;
}

/** Dash is only for a proposed link. Catalog direction stays solid. */
function selectedDash(wire: SelectedWireInput): string | undefined {
  return wire.proposed ? SELECTED_WIRE.dash : undefined;
}

function selectedColor(wire: SelectedWireInput): string | undefined {
  if (wire.rel === "evidence") return SELECTED_WIRE.colors.evidence;
  if (wire.rel === "related") return SELECTED_WIRE.colors.related;
  if (wire.rel === "role") return SELECTED_WIRE.colors.role;
  if (wire.rel === "missing") return SELECTED_WIRE.colors.missing;
  return wire.stroke;
}

export function styleSelectedWires<T extends SelectedWireInput>(wires: T[], selectedId: string | null): Array<T & SelectedWire> {
  if (!selectedId) return wires.map((wire) => ({ ...wire, selected: false, linecap: SELECTED_WIRE.linecap }));
  return wires.map((wire) => {
    if (!touchesSelection(wire, selectedId)) {
      return {
        ...wire,
        selected: false,
        linecap: SELECTED_WIRE.linecap,
        width: SELECTED_WIRE.unselectedWidth,
        opacity: Math.min(wire.opacity, SELECTED_WIRE.unselectedOpacity),
      };
    }
    return {
      ...wire,
      selected: true,
      linecap: SELECTED_WIRE.linecap,
      width: SELECTED_WIRE.width,
      opacity: Math.max(wire.opacity, 0.95),
      dash: selectedDash(wire),
      stroke: selectedColor(wire),
      markerEnd: true,
      markerStart: false,
    };
  });
}
