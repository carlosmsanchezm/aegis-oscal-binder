/**
 * Plain-language glossary for chrome labels.
 * The package map can import the same entries (Pin, gate, subset, obj n, …)
 * instead of inventing a second set of tooltips.
 */
export const glossary = {
  pin: {
    id: "pin",
    term: "Pin",
    plain: "Catalog pin",
    detail:
      "The exact baseline version this package is tied to. It cannot be edited after a package is loaded.",
  },
  ir: {
    id: "ir",
    term: "IR",
    plain: "Package record",
    detail:
      "Intermediate representation. The in-memory package that Export, Word, and Excel are built from.",
  },
  odp: {
    id: "odp",
    term: "ODP",
    plain: "Organization-defined parameter",
    detail:
      "A value the organization must set, such as a time limit. Shown for reference. The completeness gate does not check it.",
  },
  objective: {
    id: "objective",
    term: "obj n",
    plain: "Assessment objective",
    detail:
      "An 800-53A assessment objective on a statement. obj n is how many objectives that statement has. It is not a completeness failure.",
  },
  wip: {
    id: "wip",
    term: "WIP",
    plain: "Draft export",
    detail:
      "Work in progress. The OSCAL file can still be downloaded while completeness is FAIL. It is not an authorization package.",
  },
  gate: {
    id: "gate",
    term: "Gate",
    plain: "Completeness gate",
    detail:
      "Checks required fields and evidence on in-scope controls. FAIL means something required is missing. It is not an authorization result.",
  },
  subset: {
    id: "subset",
    term: "Subset",
    plain: "Control subset",
    detail:
      "This package is a subset of the FedRAMP baseline, not the full Moderate control set.",
  },
  includeControls: {
    id: "includeControls",
    term: "include-controls",
    plain: "Required enhancements",
    detail:
      "Enhancements the FedRAMP profile names with include-controls. They sit outside this subset and are not part of the completeness gate.",
  },
} as const;

export type GlossaryId = keyof typeof glossary;

export type GlossaryEntry = (typeof glossary)[GlossaryId];

export function glossaryEntry(id: GlossaryId): GlossaryEntry {
  return glossary[id];
}
