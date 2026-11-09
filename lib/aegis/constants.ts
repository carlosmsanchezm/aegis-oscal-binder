/** D6 disclaimer. Shown on every screen. Available to the UI via the package state and GET /api/disclaimer. */
export const D6_ID = "D6" as const;

export const D6_TEXT =
  "CSP side tooling demo. Subset only. Harness not LLM. Aegis is not FedRAMP authorized / not IL ATO / not a cleared facility / not 8(a).";

export const BOUNDARY_ID = "bnd-gold-0001";
export const CATALOG_PIN = "fedramp-rev5-subset@2026.09";
export const CATALOG_20X_PIN = "fedramp-20x-subset@2026.09";
// The binder supports FedRAMP Rev5 and FedRAMP 20x together.
// A later release may drop Rev5 and keep 20x only.
export const CATALOG_IDS = ["fedramp-rev5", "fedramp-20x"] as const;
export const WORKSPACE_NAME = "Gold fixture CSP boundary";
export const FIXTURE_ID = "gold";

/** Shown when FedRAMP 20x is selected. The full 20x KSI baseline is not in this repo. */
export const CATALOG_20X_STUB_NOTE =
  "Stub catalog. The full FedRAMP 20x Key Security Indicator baseline is not vendored. Four placeholder controls exist so a package can be selected, ingested, and mapped on the FedRAMP 20x path. This is not the official 20x baseline and it is not authorization evidence.";

export const CATALOG_REV5_NOTE =
  "Live subset. Pin fedramp-rev5-subset@2026.09 is the 12-control FedRAMP Rev5 subset. It is not the full FedRAMP Rev5 baseline.";

export const CLI_VALIDATE = "aegis-oscal validate --fixture gold";
export const CLI_EXPORT = "aegis-oscal export --fixture gold --out out/";
export const CLI_NOTE = "CLI peer (same IR/fixtures) · N10 · read only";

export const EVIDENCE_TYPES = ["Document", "Link", "Screenshot", "Log"] as const;

export const FUTURE_STUBS = [
  {
    id: "5a",
    title: "POA&M map",
    status: "STUB" as const,
    live: false,
    note: "placeholder · see 5a. Scan source, finding, eMASS, Jira, closure evidence. Not built.",
  },
  {
    id: "5b",
    title: "POA&M item",
    status: "STUB" as const,
    live: false,
    note: "placeholder · see 5b. eMASS record fields and Jira mirror. Not built.",
  },
  {
    id: "5c",
    title: "Weakness chain of custody",
    status: "STUB" as const,
    live: false,
    note: "placeholder · see 5c. Not built.",
  },
  {
    id: "4a",
    title: "Run detail with hashes",
    status: "STUB" as const,
    live: false,
    note: "placeholder · see 4a. Only the parity spot check is built.",
  },
  {
    id: "4b",
    title: "Field hash lineage + history",
    status: "STUB" as const,
    live: false,
    note: "placeholder · see 4b. Not built.",
  },
  {
    id: "4c",
    title: "Workspace ledger",
    status: "STUB" as const,
    live: false,
    note: "placeholder · see 4c. Not built.",
  },
] as const;
