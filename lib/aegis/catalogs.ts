import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CATALOG_20X_PIN,
  CATALOG_20X_STUB_NOTE,
  CATALOG_PIN,
  CATALOG_REV5_NOTE,
} from "./constants";
import { AegisError } from "./errors";
import { rev5CatalogPath } from "./map-graph";
import type { CatalogChoice, CatalogId, CatalogStatus, CatalogView } from "./types";

export type CatalogControl = {
  id: string;
  title: string;
  family: string;
};

export type Catalog = CatalogChoice & {
  controls: CatalogControl[];
};

type StubFile = {
  id: string;
  label: string;
  pin: string;
  status: string;
  note: string;
  controls: CatalogControl[];
};

const REV5_META: CatalogChoice = {
  id: "fedramp-rev5",
  label: "FedRAMP Rev5",
  pin: CATALOG_PIN,
  status: "live",
  note: CATALOG_REV5_NOTE,
};

let stubCache: Catalog | null = null;
let stubRoot: string | null = null;
let rev5Cache: Catalog | null = null;
let rev5Root: string | null = null;

export function isCatalogId(value: string): value is CatalogId {
  return value === "fedramp-rev5" || value === "fedramp-20x";
}

/** Pin stored for the active baseline. The binder keeps both; a later release may drop Rev5. */
export function pinForCatalog(id: CatalogId): string {
  if (id === "fedramp-20x") return CATALOG_20X_PIN;
  return CATALOG_PIN;
}

export function requireCatalogId(value: string): CatalogId {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AegisError(
      "CATALOG_REQUIRED",
      "Choose FedRAMP Rev5 or FedRAMP 20x before upload.",
      400,
    );
  }
  if (isCatalogId(trimmed)) return trimmed;
  throw new AegisError(
    "UNKNOWN_CATALOG",
    `Unknown catalog "${trimmed}". Choose FedRAMP Rev5 or FedRAMP 20x.`,
    400,
  );
}

export function catalogChoices(root: string): CatalogChoice[] {
  const stub = loadStub(root);
  return [
    REV5_META,
    { id: stub.id, label: stub.label, pin: stub.pin, status: stub.status, note: stub.note },
  ];
}

const UNSELECTED: CatalogView = {
  id: null,
  label: "Choose a baseline",
  pin: null,
  status: "unselected",
  note: "Choose FedRAMP Rev5 or FedRAMP 20x before upload or the demo sample package.",
  bound: false,
};

export function catalogSummary(root: string, id: CatalogId | null, bound: boolean): CatalogView {
  if (!id) return UNSELECTED;
  const choice = catalogChoices(root).find((item) => item.id === id);
  if (!choice) return UNSELECTED;
  return { ...choice, bound };
}

export function loadCatalog(root: string, id: CatalogId): Catalog {
  if (id === "fedramp-rev5") return loadRev5(root);
  return loadStub(root);
}

export function catalogForPin(pin: string): CatalogId | null {
  if (pin === CATALOG_PIN) return "fedramp-rev5";
  if (pin === CATALOG_20X_PIN) return "fedramp-20x";
  return null;
}

function displayCatalogId(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Base controls from the vendored NIST catalog. The gold fixture is not a title source. */
function loadRev5(root: string): Catalog {
  if (rev5Cache && rev5Root === root) return rev5Cache;
  const doc = JSON.parse(readFileSync(rev5CatalogPath(root), "utf8")) as {
    catalog?: { groups?: Array<{ id?: string; controls?: Array<{ id?: string; title?: string }> }> };
  };
  const controls: CatalogControl[] = [];
  for (const group of doc.catalog?.groups ?? []) {
    const family = (group.id ?? "").trim().toUpperCase();
    for (const control of group.controls ?? []) {
      const raw = control.id?.trim() ?? "";
      if (!/^[a-z]{2}-\d+$/i.test(raw)) continue;
      controls.push({
        id: displayCatalogId(raw),
        title: control.title?.trim() || displayCatalogId(raw),
        family: family || displayCatalogId(raw).split("-")[0],
      });
    }
  }
  if (controls.length < 12) throw new Error("NIST Rev5 catalog did not yield base controls");
  rev5Cache = { ...REV5_META, controls };
  rev5Root = root;
  return rev5Cache;
}

function loadStub(root: string): Catalog {
  if (stubCache && stubRoot === root) return stubCache;
  const file = path.join(root, "catalogs", "fedramp-20x-stub.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as StubFile;
  if (parsed.id !== "fedramp-20x") throw new Error("FedRAMP 20x stub catalog id must be fedramp-20x");
  if (parsed.pin !== CATALOG_20X_PIN) throw new Error(`FedRAMP 20x stub pin must be ${CATALOG_20X_PIN}`);
  if (parsed.status !== "stub") throw new Error("FedRAMP 20x catalog must stay status stub until a full baseline is vendored");
  if (parsed.note !== CATALOG_20X_STUB_NOTE) {
    throw new Error("FedRAMP 20x stub note must match CATALOG_20X_STUB_NOTE");
  }
  if (!Array.isArray(parsed.controls) || parsed.controls.length < 1) {
    throw new Error("FedRAMP 20x stub catalog needs at least one control");
  }
  const status: CatalogStatus = "stub";
  stubCache = {
    id: "fedramp-20x",
    label: parsed.label || "FedRAMP 20x",
    pin: parsed.pin,
    status,
    note: parsed.note,
    controls: parsed.controls.map((control) => ({
      id: control.id,
      title: control.title,
      family: control.family,
    })),
  };
  stubRoot = root;
  return stubCache;
}
