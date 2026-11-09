import rules from "../../catalogs/collector-relevance.json" with {type: "json"};
import {moderateControls} from "../aegis/moderate-baseline";
import type {CollectedArtifact, EvidenceFact} from "./types";

// Build the catalog/rule join once. Runtime work follows the artifact's fact keys,
// rather than rescanning every baseline control and rule for every fact.
const catalog = moderateControls().filter(control => !control.enhancement);
const byFact = new Map<string, typeof catalog>();
for (const rule of rules) for (const key of rule.facts) {
 const titles = new Set(rule.titles.map(title => title.toLowerCase()));
 const controls = catalog.filter(control => titles.has(control.title.toLowerCase()));
 byFact.set(key, [...new Map([...(byFact.get(key) ?? []), ...controls].map(control => [control.id,control])).values()]);
}
export function factCandidates(artifact: CollectedArtifact, allowed: Set<string>, catalogId: string) {
 if (catalogId !== "fedramp-rev5") return [];
 const factsByControl = new Map<string,EvidenceFact[]>();
 for (const fact of artifact.facts) for (const control of byFact.get(fact.key) ?? []) {
  if (!allowed.has(control.id)) continue;
  const facts = factsByControl.get(control.id) ?? [];
  facts.push(fact); factsByControl.set(control.id,facts);
 }
 return catalog.flatMap(control => {
  const facts = factsByControl.get(control.id);
  return facts?.length ? [{controlId:control.id,family:control.family,coverageOnly:true as const,
   reasons:facts.map(fact => `${artifact.source.path}:${fact.line} · ${fact.content}${fact.outcome === "fail" ? " · failed fact; review required" : ""}. May support “${control.title}”; coverage only, applicability needs a person.`)}] : [];
 });
}

export function collectedFindings(artifacts: CollectedArtifact[]) {
  const allowed = new Set(moderateControls().map(c => c.id));
  return artifacts.flatMap(artifact => {
    const failed = artifact.facts.filter(f=>f.outcome === "fail");
    if (!failed.length) return [];
    const candidates = factCandidates({...artifact, facts: failed}, allowed, "fedramp-rev5");
    if (!candidates.length) return [];
    return [{mappingStatus: "proposed" as const, id: `source-${artifact.name.replace(/\.json$/, "")}`,
      description: `${artifact.source.path}: ${failed.length} failed facts. ${failed.slice(0,4).map(f=>`Line ${f.line} · ${f.content}`).join("; ")}. Inspect the retained fact inventory; review applicability before accepting a plan.`,
      scope: {title: `Review failed source facts`, asset: artifact.source.path, controls: candidates.map(c=>c.controlId), framework: "NIST SP 800-53 Rev 5",
        baseline: "Catalog relevance proposal; no full-control assessment.", artifacts: [artifact.name],
        verification: ["Collect corrected evidence and confirm all failed facts are resolved against approved criteria."], remainingScope: artifact.limitations}}];
  });
}
