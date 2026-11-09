import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_20X_PIN, CATALOG_PIN } from "../lib/aegis/constants";
import { getPackageState } from "../lib/aegis/derive";
import { shortCommit } from "../lib/aegis/build";
import { glossary, glossaryEntry } from "../lib/aegis/glossary";
import { assertCatalogChosen, emptyPersisted, resetPackage, selectCatalog } from "../lib/aegis/operations";
import { findRepoRoot } from "../lib/aegis/paths";
import { AegisError } from "../lib/aegis/errors";

const ctx = { root: findRepoRoot() };

test("short commit falls back to local and keeps seven characters", () => {
  assert.equal(shortCommit(undefined), "unknown");
  assert.equal(shortCommit(""), "unknown");
  assert.equal(shortCommit("   "), "unknown");
  assert.equal(shortCommit("8dd9b7e4c0ff"), "8dd9b7e");
});

test("glossary covers the chrome jargon in one module", () => {
  for (const id of ["pin", "ir", "odp", "objective", "wip", "gate", "subset", "includeControls"] as const) {
    const entry = glossaryEntry(id);
    assert.equal(entry.id, id);
    assert.equal(glossary[id], entry);
    assert.ok(entry.plain.length > 0);
    assert.ok(entry.detail.length > 20);
  }
  assert.match(glossary.objective.term, /obj n/);
  assert.match(glossary.includeControls.term, /include-controls/);
  assert.match(glossary.wip.detail, /FAIL/);
});

test("catalog id is the selection, including when the stored pin drifted", () => {
  const drifted = { ...emptyPersisted(), catalogId: "fedramp-rev5" as const, catalogPin: null };
  assert.equal(assertCatalogChosen(drifted, "fedramp-rev5", "upload"), "fedramp-rev5");
  assert.equal(assertCatalogChosen(drifted, "", "gold"), "fedramp-rev5");
  const view = getPackageState(drifted, ctx);
  assert.equal(view.catalog.id, "fedramp-rev5");
  assert.equal(view.catalogPin, CATALOG_PIN);
  assert.equal(view.catalog.bound, false);

  const twenty = { ...emptyPersisted(), catalogId: "fedramp-20x" as const, catalogPin: CATALOG_PIN };
  assert.equal(assertCatalogChosen(twenty, "fedramp-20x", "upload"), "fedramp-20x");
  assert.equal(getPackageState(twenty, ctx).catalogPin, CATALOG_20X_PIN);
  assert.throws(() => assertCatalogChosen(twenty, "fedramp-rev5", "upload"), (error: unknown) => {
    return error instanceof AegisError && error.code === "CATALOG_MISMATCH";
  });
  assert.throws(() => assertCatalogChosen(emptyPersisted(), "", "upload"), (error: unknown) => {
    return error instanceof AegisError && error.code === "CATALOG_REQUIRED";
  });
});

test("new package keeps the chosen catalog and a workspace reset does not", () => {
  const selected = selectCatalog(emptyPersisted(), "fedramp-rev5");
  const cleared = resetPackage(selected);
  assert.equal(cleared.loaded, false);
  assert.equal(cleared.catalogId, "fedramp-rev5");
  assert.equal(cleared.catalogPin, CATALOG_PIN);
  assert.equal(cleared.workspaceName, null);

  const kept20 = resetPackage(selectCatalog(emptyPersisted(), "fedramp-20x"));
  assert.equal(kept20.catalogId, "fedramp-20x");
  assert.equal(kept20.catalogPin, CATALOG_20X_PIN);

  const fresh = resetPackage(emptyPersisted());
  assert.equal(fresh.catalogId, null);
  assert.equal(fresh.catalogPin, null);
});
