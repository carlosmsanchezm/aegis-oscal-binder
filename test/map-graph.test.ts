import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { descendantParams, directedLinksFor, enhancementOfParam, paramChip, parameterPhrase, partitionConstraints, proseSegments, spanInterval } from "../lib/aegis/map-view";
import {
  loadRev5Index,
  packageMapFor,
  rev5CatalogPath,
  rev5ProfilePath,
  sha256File,
} from "../lib/aegis/map-graph";
import { emptyPersisted, findRepoRoot, getPackageState, loadFixture } from "../lib/aegis";
import type { Ctx } from "../lib/aegis/types";

const root = findRepoRoot();

type TruthEdge = {
  from_id: string;
  to_id: string;
  citation: string;
  in_subset: boolean;
  mutual_in_catalog: boolean;
  subset_mark: string;
};

type Truth = {
  pins: { catalog_sha256: string; profile_primary_sha256: string; catalog_uuid: string; profile_uuid: string };
  edge_counts: {
    directed_in_subset: number;
    directed_out_of_subset: number;
    undirected_in_subset_pairs: number;
    unique_out_of_subset_targets: number;
  };
  edges: TruthEdge[];
  controls: Array<{
    id: string;
    related_catalog: string[];
    profile_included_enhancements: string[];
    profile_set_parameters: Array<{ "param-id": string; constraints: Array<{ description: string }> }>;
  }>;
};

function truth(): Truth {
  return JSON.parse(readFileSync(path.join(root, "fixtures", "rev5", "map-relationship-truth.json"), "utf8")) as Truth;
}

function goldControls() {
  const ctx: Ctx = { root, now: () => new Date("2026-09-24T15:00:00.000Z") };
  return getPackageState(loadFixture(emptyPersisted(), "gold", ctx), ctx);
}

test("shipped catalog and profile match the truth-table pins", () => {
  const table = truth();
  assert.equal(sha256File(rev5CatalogPath(root)), table.pins.catalog_sha256);
  assert.equal(sha256File(rev5ProfilePath(root)), table.pins.profile_primary_sha256);
  assert.equal(sha256File(rev5CatalogPath(root)), "d820835aa54aeb2265bdacdf8e678af7530443a59556563df898addf012024cb");
  assert.equal(sha256File(rev5ProfilePath(root)), "9a31036e9f66e0d8cd9d15a981a9f956e9043562a882f44bd78048c7a86820e2");
  const source = readFileSync(path.join(root, "lib", "aegis", "map-graph.ts"), "utf8");
  assert.equal(source.includes("map-relationship-truth"), false);
  assert.match(source, /NIST_SP-800-53_rev5_catalog-min\.json/);
  assert.match(source, /fedramp-rev5-moderate-profile\.json/);
  assert.match(source, /catalog\.groups\[\]\.controls\[id=\$\{from\}\]\.links\[href=#\$\{target\} rel=related\]/);
});

test("Rev5 package map locks the 45 IN_SUBSET directed edges", () => {
  const table = truth();
  const map = goldControls().map;
  assert.equal(map.available, true);
  assert.equal(map.subsetMatch, true);
  assert.equal(map.level, 1);
  assert.equal(table.edge_counts.directed_in_subset, 45);
  assert.equal(table.edge_counts.undirected_in_subset_pairs, 30);
  assert.equal(map.directedInSubset, 45);
  assert.equal(map.undirectedPairs, 30);
  assert.equal(map.edges.length, 45);

  const inset = table.edges.filter((edge) => edge.in_subset && edge.subset_mark === "IN_SUBSET");
  assert.equal(inset.length, 45);
  const derived = map.edges.map((edge) => `${edge.fromId.toLowerCase()}->${edge.toId.toLowerCase()}|${edge.mutual}|${edge.citation}`).sort();
  const expected = inset.map((edge) => `${edge.from_id}->${edge.to_id}|${edge.mutual_in_catalog}|${edge.citation}`).sort();
  assert.deepEqual(derived, expected);

  const subset = new Set(table.controls.map((control) => control.id));
  assert.equal(map.edges.every((edge) => subset.has(edge.fromId.toLowerCase()) && subset.has(edge.toId.toLowerCase())), true);

  let outsideCount = 0;
  const outsideIds = new Set<string>();
  for (const [id, facts] of Object.entries(map.byControl)) {
    outsideCount += facts.outOfSubsetCount;
    for (const label of facts.outOfSubset) outsideIds.add(`${id}:${label}`);
    assert.equal(facts.outOfSubset.length, facts.outOfSubsetCount);
    for (const edge of map.edges) {
      if (edge.fromId === id) assert.equal(facts.outOfSubset.includes(edge.toId), false);
    }
  }
  assert.equal(outsideCount, table.edge_counts.directed_out_of_subset);
  assert.equal(outsideCount, 236);
  const uniqueTargets = new Set<string>();
  for (const facts of Object.values(map.byControl)) {
    for (const label of facts.outOfSubset) uniqueTargets.add(label);
  }
  assert.equal(uniqueTargets.size, table.edge_counts.unique_out_of_subset_targets);
  assert.equal(uniqueTargets.size, 119);
});

test("AC-2 directed links, outside targets, and Moderate baseline facts match the truth table", () => {
  const table = truth();
  const map = goldControls().map;
  const links = directedLinksFor(map.edges, "AC-2");
  assert.deepEqual(links.mutual.map((link) => link.otherId), ["AC-3", "AC-6", "AU-2", "IA-2"]);
  assert.deepEqual(links.outbound.map((link) => link.otherId), ["IA-5", "SC-7"]);
  assert.deepEqual(links.reverse.map((link) => link.otherId), ["AU-6"]);
  assert.match(links.mutual[0]?.citation ?? "", /controls\[id=ac-2\]\.links\[href=#ac-3 rel=related\]/);

  const ac2 = table.controls.find((control) => control.id === "ac-2");
  assert.ok(ac2);
  const facts = map.byControl["AC-2"];
  assert.ok(facts);
  const subset = new Set(["ac-2", "ac-3", "ac-6", "au-2", "au-6", "cm-2", "cm-6", "ia-2", "ia-5", "sc-7", "sc-8", "si-2"]);
  const expectedOutside = ac2.related_catalog.filter((id) => !subset.has(id)).map((id) => id.toUpperCase());
  assert.deepEqual(facts.outOfSubset, expectedOutside);
  assert.equal(facts.outOfSubsetCount, 22);
  assert.equal(facts.outOfSubset.includes("AC-5"), true);
  assert.equal(facts.outOfSubset.includes("AC-3"), false);

  assert.deepEqual(facts.requiredEnhancements.map((item) => item.id), ac2.profile_included_enhancements);
  assert.equal(facts.requiredEnhancements.length, 9);
  assert.equal(facts.requiredEnhancements[0]?.label, "AC-2(1)");
  assert.equal(facts.requiredEnhancements[0]?.title, "Automated System Account Management");
  assert.deepEqual(
    facts.constraints.map((item) => [item.paramId, item.description]),
    ac2.profile_set_parameters.map((item) => [item["param-id"], item.constraints.map((constraint) => constraint.description).join("; ")]),
  );
  assert.equal(facts.constraints.find((item) => item.paramId === "ac-02_odp.06")?.description, "twenty-four (24) hours");
  assert.equal(facts.constraints.find((item) => item.paramId === "ac-02_odp.10")?.description, "quarterly for privileged access, annually for non-privileged access");

  const pkg = goldControls();
  const items = pkg.map.statements["AC-2"]?.items ?? [];
  const packageIds = new Set(pkg.controls.map((item) => item.id.toLowerCase()));
  const split = partitionConstraints(facts.constraints, packageIds);
  assert.equal(split.base.some((item) => item.paramId === "ac-02_odp.06"), true);
  assert.equal(split.base.some((item) => item.paramId === "ac-02_odp.10"), true);
  assert.equal(split.base.some((item) => enhancementOfParam(item.paramId) != null), false);
  assert.ok(split.more > 0);
  assert.equal(facts.constraints.length, split.base.length + split.more);
  const notify = parameterPhrase("ac-02_odp.06", items, "parameter");
  assert.match(notify, /notify/);
  assert.match(notify, /accounts/);
  assert.match(notify, /required/);
  assert.match(parameterPhrase("ac-02_odp.10", items, "parameter"), /review accounts/);

  const moderate = Object.fromEntries(map.families.map((family) => [family.id, family.moderateBase]));
  assert.deepEqual(moderate, { AC: 17, AU: 11, CM: 12, IA: 10, SC: 19, SI: 12 });
  const within = Object.fromEntries(map.families.map((family) => [family.id, family.withinPairs]));
  assert.deepEqual(within, { AC: 3, AU: 1, CM: 1, IA: 1, SC: 1, SI: 0 });
  const bundles = Object.fromEntries(map.bundles.map((bundle) => [`${bundle.left}-${bundle.right}`, bundle.pairs]));
  assert.deepEqual(bundles, {
    "AC-AU": 6,
    "AC-CM": 1,
    "AC-IA": 5,
    "AC-SC": 1,
    "AU-CM": 3,
    "AU-IA": 2,
    "AU-SC": 2,
    "CM-IA": 1,
    "CM-SC": 1,
    "CM-SI": 1,
  });

  const ia5 = map.byControl["IA-5"];
  assert.match(ia5?.alterSummary ?? "", /ia-5_fr/);
  assert.match(ia5?.alterSummary ?? "", /IA-5 Additional FedRAMP Requirements and Guidance/);
  assert.equal(map.byControl["AC-2"]?.alterSummary, null);
});

test("a partial Rev5 package does not invent edges to controls that are not loaded", () => {
  const map = packageMapFor(root, "fedramp-rev5", [
    { id: "AC-2", family: "AC" },
    { id: "AC-3", family: "AC" },
  ]);
  assert.equal(map.subsetMatch, false);
  assert.deepEqual(
    map.edges.map((edge) => `${edge.fromId}->${edge.toId}`).sort(),
    ["AC-2->AC-3", "AC-3->AC-2"],
  );
  assert.equal(map.edges.every((edge) => edge.mutual), true);
  assert.equal(map.byControl["AC-2"]?.outOfSubset.includes("AC-6"), true);
  assert.equal(map.byControl["AC-2"]?.outOfSubset.includes("AC-3"), false);
  assert.equal(map.bundles.length, 0);
  assert.equal(map.families.find((family) => family.id === "AC")?.withinPairs, 1);
});

test("a shared role or evidence chip spans every control it covers", () => {
  const boxes = [
    { id: "AC-3", x: 80, w: 70 },
    { id: "AC-6", x: 156, w: 70 },
    { id: "IA-2", x: 400, w: 70 },
  ];
  assert.deepEqual(spanInterval(boxes, ["AC-3", "AC-6"]), { x: 80, w: 146 });
  assert.deepEqual(spanInterval(boxes, ["AC-3", "IA-2"]), { x: 80, w: 390 });
  assert.equal(spanInterval(boxes, ["SC-7"]), null);
});

test("AC-2 statement parts match the truth table and do not invent item coverage", () => {
  const table = JSON.parse(readFileSync(path.join(root, "fixtures", "rev5", "map-relationship-truth.json"), "utf8")) as Truth & {
    ac2_parts: Array<{ id: string; name: string; label: string | null; prose_trunc: string; depth: number }>;
    ac2_item_j: { exists: boolean; part_id: string; label: string; prose_trunc: string; assessment_objective_id: string };
  };
  const pkg = goldControls();
  const ac2 = pkg.map.statements["AC-2"];
  assert.ok(ac2);
  assert.equal(ac2.statementId, "ac-2_smt");
  assert.deepEqual(
    ac2.parts.map((part) => ({ id: part.id, name: part.name, label: part.label, prose: part.prose, depth: part.depth })),
    table.ac2_parts.map((part) => ({ id: part.id, name: part.name, label: part.label, prose: part.prose_trunc, depth: part.depth })),
  );
  assert.equal(table.ac2_item_j.exists, true);
  const itemJ = ac2.items.find((item) => item.id === table.ac2_item_j.part_id);
  assert.ok(itemJ);
  assert.equal(itemJ.label, table.ac2_item_j.label);
  assert.equal(itemJ.prose, table.ac2_item_j.prose_trunc);
  assert.equal(itemJ.objectives[0]?.id, table.ac2_item_j.assessment_objective_id);
  assert.equal(itemJ.objectiveCount, 1);
  assert.deepEqual(
    ac2.items.map((item) => [item.label, item.objectiveCount]),
    [
      ["a.", 2],
      ["b.", 1],
      ["c.", 1],
      ["d.", 4],
      ["e.", 1],
      ["f.", 5],
      ["g.", 1],
      ["h.", 3],
      ["i.", 3],
      ["j.", 1],
      ["k.", 2],
      ["l.", 2],
    ],
  );
  const itemC = ac2.items.find((item) => item.id === "ac-2_smt.c");
  const itemH = ac2.items.find((item) => item.id === "ac-2_smt.h");
  assert.ok(itemC && itemH);
  assert.equal(itemC.params[0]?.paramId, "ac-02_odp.01");
  assert.equal(itemC.params[0]?.constraint, null);
  const hParams = descendantParams(itemH);
  assert.equal(hParams.find((param) => param.paramId === "ac-02_odp.05")?.constraint, null);
  assert.equal(hParams.find((param) => param.paramId === "ac-02_odp.06")?.constraint, "twenty-four (24) hours");
  assert.equal(hParams.find((param) => param.paramId === "ac-02_odp.07")?.constraint, "eight (8) hours");
  assert.equal(hParams.find((param) => param.paramId === "ac-02_odp.08")?.constraint, "eight (8) hours");
  assert.equal(itemJ.params[0]?.constraint, "quarterly for privileged access, annually for non-privileged access");
  assert.deepEqual(paramChip("h.", hParams.find((param) => param.paramId === "ac-02_odp.06")!), {
    tone: "constraint",
    text: "h.1 · twenty-four (24) hours",
  });
  assert.deepEqual(paramChip("c.", itemC.params[0]!), { tone: "open", text: "odp.01" });
  const rendered = proseSegments(itemJ.prose, ac2.paramIndex);
  assert.equal(rendered.some((segment) => segment.kind === "constraint" && segment.text.includes("quarterly for privileged")), true);
  assert.equal(JSON.stringify(ac2).includes("EV-"), false);
  assert.equal(JSON.stringify(ac2).includes("EV-IDP-01"), false);
  assert.equal(pkg.gate.incomplete, 3);
  assert.equal(pkg.gate.status, "FAIL");
  assert.equal(pkg.map.statements["AU-2"]?.items.length, 5);
  assert.equal(pkg.map.statements["AC-2"]?.items.some((item) => item.id === "ac-2.1"), false);
  const ac3 = pkg.map.statements["AC-3"];
  assert.equal(ac3?.items.length, 1);
  assert.equal(ac3?.items[0]?.id, "ac-3_smt");
  assert.match(ac3?.items[0]?.prose ?? "", /Enforce approved authorizations for logical access/);
  assert.equal(ac3?.items[0]?.label, null);

  const partial = packageMapFor(root, "fedramp-rev5", [
    { id: "AC-2", family: "AC" },
    { id: "AC-3", family: "AC" },
  ]);
  assert.equal(partial.statements["AC-2"]?.parts.length, ac2.parts.length);
  assert.equal(partial.statements["SI-2"], undefined);
  const stub = packageMapFor(root, "fedramp-20x", [{ id: "KSI-IAM", family: "KSI" }]);
  assert.deepEqual(stub.statements, {});
});

test("the Rev5 index reads the catalog uuid from the fixture", () => {
  const index = loadRev5Index(root);
  assert.equal(index.catalogTitle.includes("800-53"), true);
  assert.equal(truth().pins.catalog_uuid, "ea7c7688-79c5-463b-a91b-0650f2d98623");
  assert.equal(truth().pins.profile_uuid, "2b52ae35-a912-4549-94db-5a43b6607f86");
});
