import { checkState, type CheckState } from "../builder/evidence";
import { observationControl } from "./connected-evidence";
import { moderateControls, type BaselineControl } from "./moderate-baseline";
import { parseStoredPipelineEvidence } from "./pipeline-inbound";
import { artifactFilename, gitlabArtifactUrl, type PipelineEvidence } from "./pipeline-evidence";
import { withRecordedReviewObservations } from "./recorded-review-observations";
import type { ReviewObservation } from "./review-context";
import { parsePipelineVerification } from "./pipeline-verification";
import podinfoRetestReceiptJson from "../../test/fixtures/podinfo-received-retest.json";

export type RollupCheck = {
  description: string; result: string; date: string; reviewer: string; href: string;
  artifactSha256?: string; verdict?: "pass" | "fail";
  reportedVerdict?: "pass" | "fail" | "unknown"; evidenceState?: CheckState; validUntil?: string;
};
export type ProvenResult = {
  mappingStatus?: "proposed";
  controlId: string; reviewItemId?: string; releaseId: string; releaseUrl: string; commit: string; createdAt: string;
  coverage: string; evidence: string[]; finding: string; findingTitle: string; checks: RollupCheck[];
  correctiveReleaseId: string; correctiveReleaseUrl: string;
  releaseSha256: string; artifactJobId: string; asset: string;
  sourceReleaseUrl: string; sourceCommit: string; sourceReleaseSha256: string;
  sourceReleaseId: string; sourceArtifacts: { name: string; href: string }[];
  sourceCreatedAt?: string;
};
export type ControlRollupRow = BaselineControl & { result: ProvenResult | null };
type ReviewResultCache = WeakMap<PipelineEvidence, Map<ReviewObservation, Map<string, ProvenResult | null>>>;

/** One rollup's history is fixed; never retain this cache across snapshots or clock reads. */
function reviewResult(source:PipelineEvidence,item:ReviewObservation,controlId:string,history:PipelineEvidence[],cache?:ReviewResultCache):ProvenResult|null {
  if(!cache)return resultForReviewItem(source,item,controlId,history);
  let items=cache.get(source);if(!items){items=new Map();cache.set(source,items);}
  let controls=items.get(item);if(!controls){controls=new Map();items.set(item,controls);}
  if(!controls.has(controlId))controls.set(controlId,resultForReviewItem(source,item,controlId,history));
  // A caller can add accepted family links to its row; that must not widen another row.
  return structuredClone(controls.get(controlId)!);
}

/** Project scope is an integration boundary, not an agency authorization boundary. */
export function releaseProject(pipelineUrl: string): string {
  const url = new URL(pipelineUrl);
  if (/^\/api\/builder\/evidence\/[a-f0-9]{64}$/.test(url.pathname)) return `binder-connection:${url.searchParams.get("connection")}`;
  return `${url.origin}${url.pathname.replace(/\/-\/pipelines\/[^/]+\/?$/, "").replace(/\/actions\/runs\/[^/]+\/?$/, "")}`;
}
function releaseTime(release: PipelineEvidence): number { return Date.parse(release.createdAt) || 0; }
function blankResult(release: PipelineEvidence, controlId: string): ProvenResult {
  return {
    controlId, releaseId: release.pipelineId, releaseUrl: release.pipelineUrl, commit: release.commitSha,
    createdAt: release.createdAt, coverage: "", evidence: [], finding: "", findingTitle: "", checks: [],
    correctiveReleaseId: "", correctiveReleaseUrl: "", releaseSha256: release.releaseSha256,
    artifactJobId: release.artifactJobId, asset: "", sourceReleaseUrl: release.pipelineUrl,
    sourceCommit: release.commitSha, sourceReleaseSha256: release.releaseSha256,
    sourceReleaseId: release.pipelineId, sourceArtifacts: [], sourceCreatedAt: release.createdAt,
  };
}
function linkedArtifacts(release: PipelineEvidence, names: string[]): { name: string; href: string }[] {
  // A mapping is not an inventory. Require a listed file and a supported producing-job link.
  const inventory = new Set((release.artifacts ?? release.checks.map(c => c.artifact)).map(artifactFilename));
  return [...new Set(names.map(artifactFilename))].flatMap(name => {
    const href = inventory.has(name) ? gitlabArtifactUrl(release, name) : null;
    return href ? [{ name, href }] : [];
  });
}

/** Linked evidence is an observation, never a full-control pass or a reviewer decision. */
export function evidenceForRelease(release: PipelineEvidence, history: PipelineEvidence[] = []): Map<string, ProvenResult> {
  return evidenceForReleaseInternal(release,history);
}
function evidenceForReleaseInternal(release:PipelineEvidence,history:PipelineEvidence[],cache?:ReviewResultCache):Map<string,ProvenResult> {
  const map = new Map<string, ProvenResult>();
  const touch = (id: string) => {
    const key = id.trim().toUpperCase();
    const row = map.get(key) ?? blankResult(release, key);
    map.set(key, row);
    return row;
  };
  const includeOwnFindings = () => {
    for (const item of release.reviewItems ?? []) {
      for (const id of item.scope.controls) {
        const own = reviewResult(release, item, id, history, cache);
        if (own) map.set(own.controlId, own);
      }
    }
    return map;
  };
  if (release.schema === "aegis.evidence-event.v1") {
    for (const check of release.observation.checks) {
      const control = observationControl(check);
      if (!control) continue;
      const artifacts = linkedArtifacts(release, check.artifacts);
      if (artifacts.length !== check.artifacts.length) continue;
      let state = checkState({ run: { id: release.pipelineId, producer: release.observation.producer, observedAt: release.createdAt } }, check);
      const latestSubject = history.filter(r => r.schema === "aegis.evidence-event.v1" && releaseProject(r.pipelineUrl) === releaseProject(release.pipelineUrl) && r.observation.subject.kind === release.observation.subject.kind && r.observation.subject.id === release.observation.subject.id).sort((a, b) => releaseTime(b) - releaseTime(a))[0];
      if (latestSubject?.schema === "aegis.evidence-event.v1" && (latestSubject.commitSha !== release.commitSha || !latestSubject.observation.checks.some(c => c.id === check.id && c.version === check.version && JSON.stringify(c.requirement) === JSON.stringify(check.requirement)))) state = "outdated";
      const row = touch(control);
      row.asset = release.observation.subject.id;
      row.coverage = `${check.requirement.objective} · ${state}; producer-declared mapping, selected objective only.`;
      row.evidence = [...new Set([...row.evidence, ...check.artifacts])];
      row.sourceArtifacts = artifacts;
      // Current measurements are visible even without an earlier finding; no full-control pass.
      row.checks.push({ description: check.requirement.objective, result: `Reported ${check.verdict}`, reportedVerdict: check.verdict, evidenceState: state, validUntil: check.validUntil, date: release.createdAt.slice(0, 10), reviewer: `${release.observation.producer} · identity unverified`, href: artifacts[0].href,
        ...(state === "pass" || state === "fail" ? { verdict: state } : {}) });
    }
    // A later matching retest keeps the original finding visible in the control map.
    // Passing a criterion does not erase the finding or record a reviewer decision.
    for (const original of history) {
      if (original.schema !== "aegis.evidence-event.v1" || releaseTime(original) >= releaseTime(release) || releaseProject(original.pipelineUrl) !== releaseProject(release.pipelineUrl)) continue;
      for (const item of original.reviewItems ?? []) for (const control of item.scope.controls) {
        const retest = reviewResult(original, item, control, history, cache);
        if (retest?.correctiveReleaseUrl === release.pipelineUrl) map.set(control, retest);
      }
    }
    // Preserve the existing person-approved artifact mapping workflow as evidence links.
    // It adds no test verdict, finding scope or framework equivalence.
    for (const family of release.families) {
      const artifacts = linkedArtifacts(release, family.evidence);
      if (!artifacts.length) continue;
      for (const control of family.controls) {
        const row = touch(control);
        row.coverage ||= family.coverage;
        row.evidence = [...new Set([...row.evidence, ...artifacts.map(a => a.name)])];
      }
    }
    return includeOwnFindings();
  }
  if (release.verification) {
    // Only the exact bound review scope is retested. Other scanner outputs are not its verification.
    if (release.source !== "Inbound pipeline event") return includeOwnFindings();
    let verification;
    try { verification = parsePipelineVerification(release.verification, release); } catch { return includeOwnFindings(); }
    const original = history.find(r => r.pipelineUrl === verification.sourcePipelineUrl && r.commitSha === verification.sourceCommit && r.releaseSha256 === verification.sourceReleaseSha256 && releaseProject(r.pipelineUrl) === releaseProject(release.pipelineUrl));
    if (!original) return includeOwnFindings();
    for (const item of original.reviewItems ?? []) {
      const scope = item.scope;
      if (!scope || scope.verification.length !== verification.tests.length || scope.verification.some(description => !verification.tests.some(t => t.description === description))) continue;
      const sourceArtifacts = linkedArtifacts(original, scope.artifacts);
      if (sourceArtifacts.length !== scope.artifacts.length) continue;
      const checks = verification.tests.map(t => ({ ...t, reviewer: `Pipeline evidence collector · job #${release.artifactJobId}`, href: gitlabArtifactUrl(release, t.artifact) ?? "" }));
      if (checks.some(c => !c.href)) continue;
      for (const id of scope.controls) {
        const row = touch(id);
        Object.assign(row, {
          asset: scope.asset, finding: item.description, findingTitle: scope.title, reviewItemId: item.id,
          coverage: "Measured verification for the bound review scope; no full-control assessment or approval is inferred.",
          evidence: [...new Set(verification.tests.map(t => t.artifact))], checks,
          correctiveReleaseId: release.pipelineId, correctiveReleaseUrl: release.pipelineUrl,
          sourceReleaseUrl: original.pipelineUrl, sourceCommit: original.commitSha,
          sourceReleaseSha256: original.releaseSha256, sourceReleaseId: original.pipelineId, sourceArtifacts, sourceCreatedAt: original.createdAt,
        });
      }
    }
    // The corrective release can also carry a different, still-open finding.
    return includeOwnFindings();
  }
  for (const family of release.families) {
    const evidence = linkedArtifacts(release, family.evidence);
    if (!evidence.length) continue;
    for (const id of family.controls) {
      const row = touch(id);
      row.coverage ||= family.coverage;
      row.evidence = [...new Set([...row.evidence, ...evidence.map(a => a.name)])];
    }
  }
  for (const item of release.reviewItems ?? []) {
    if (!item.scope) continue;
    const sourceArtifacts = linkedArtifacts(release, item.scope.artifacts);
    if (!sourceArtifacts.length) continue;
    for (const id of item.scope.controls) {
      const row = touch(id);
      if (!row.finding) {
        row.finding = item.description;
        row.findingTitle = item.scope.title;
        row.asset = item.scope.asset;
        row.reviewItemId = item.id;
        row.sourceArtifacts = sourceArtifacts;
      }
      row.evidence = [...new Set([...row.evidence, ...sourceArtifacts.map(a => a.name)])];
    }
  }
  // Legacy recordedChecks are not trusted as received measured verification.
  return map;
}

/** Resolve a single scoped finding independently of the control's latest aggregate result. */
export function resultForReviewItem(source: PipelineEvidence, item: ReviewObservation, controlId: string, history: PipelineEvidence[]): ProvenResult | null {
  const key = controlId.trim().toUpperCase();
  if (!item.scope.controls.some(id => id.trim().toUpperCase() === key)) return null;
  const sourceArtifacts = linkedArtifacts(source, item.scope.artifacts);
  if (!sourceArtifacts.length || sourceArtifacts.length !== new Set(item.scope.artifacts).size) return null;
  let result: ProvenResult = {
    ...blankResult(source, key), reviewItemId: item.id, asset: item.scope.asset,
    ...(item.mappingStatus === "proposed" && !source.families.some(f=>f.controls.includes(key) && item.scope.artifacts.every(a=>f.evidence.includes(a))) ? {mappingStatus:"proposed" as const} : {}),
    finding: item.description, findingTitle: item.scope.title, sourceArtifacts,
    evidence: sourceArtifacts.map(artifact => artifact.name),
    coverage: "Recorded scoped finding; a passing retest is not yet attached.",
  };
  const scopedSource = { ...source, reviewItems: [item] };
  for (const candidate of [...history].sort((a, b) => releaseTime(a) - releaseTime(b))) {
    if (source.schema === "aegis.evidence-event.v1" && candidate.schema === "aegis.evidence-event.v1") {
      if (releaseTime(candidate) <= releaseTime(source) || releaseProject(candidate.pipelineUrl) !== releaseProject(source.pipelineUrl)) continue;
      const original = source.observation.checks[Number(item.id.replace("check-", ""))];
      if (!original || candidate.observation.subject.kind !== source.observation.subject.kind || candidate.observation.subject.id !== source.observation.subject.id) continue;
      // A changed criterion or a newer revision without this check invalidates prior retest readiness.
      const test = candidate.observation.checks.find(c => c.id === original.id && c.version === original.version && JSON.stringify(c.requirement) === JSON.stringify(original.requirement));
      result = { ...result, checks: [], correctiveReleaseId: "", correctiveReleaseUrl: "" };
      if (!test || candidate.commitSha === source.commitSha) continue;
      const artifacts = linkedArtifacts(candidate, test.artifacts);
      if (artifacts.length !== test.artifacts.length) continue;
      const state = checkState({ run: { id: candidate.pipelineId, producer: candidate.observation.producer, observedAt: candidate.createdAt } }, test);
      result = { ...result, releaseId: candidate.pipelineId, releaseUrl: candidate.pipelineUrl, commit: candidate.commitSha, createdAt: candidate.createdAt,
        releaseSha256: candidate.releaseSha256, artifactJobId: candidate.artifactJobId, evidence: test.artifacts,
        correctiveReleaseId: candidate.pipelineId, correctiveReleaseUrl: candidate.pipelineUrl,
        coverage: "Retained producer-reported retest for the exact subject and objective; reviewer acceptance is separate.",
        checks: [{ description: test.requirement.objective, result: `Reported ${test.verdict}`, reportedVerdict: test.verdict, evidenceState: state, validUntil: test.validUntil, date: candidate.createdAt.slice(0, 10), reviewer: `${candidate.observation.producer} · identity unverified`, href: artifacts[0].href,
          artifactSha256: candidate.observation.artifactDigests.find(a => a.name === test.artifacts[0])?.sha256,
          ...(state === "pass" || state === "fail" ? { verdict: state } : {}) }] };
      continue;
    }
    if (!candidate.verification || releaseTime(candidate) < releaseTime(source)) continue;
    const measured = evidenceForRelease({ ...candidate, reviewItems: [] }, [scopedSource]).get(key);
    if (measured?.finding === item.description && measured.sourceReleaseUrl === source.pipelineUrl && measured.sourceCommit === source.commitSha && measured.sourceReleaseSha256 === source.releaseSha256) {
      result = { ...measured, reviewItemId: item.id };
    }
  }
  return result;
}

/**
 * Captured Podinfo retest receipt. It is the stored later release for that
 * project, not a result invented for the release currently on screen.
 * Another project's URL does not receive it. A received copy of the same
 * pipeline, commit, and hash replaces this receipt.
 */
export const PODINFO_RETEST_RECEIPT: PipelineEvidence = withRecordedReviewObservations(parseStoredPipelineEvidence(podinfoRetestReceiptJson));

/** Stored workspace history only. Received copies win on the same identity. */
export function mergeStoredReleases(received: PipelineEvidence[] = [], sourceUrl = received[0]?.pipelineUrl): PipelineEvidence[] {
  const unique = new Map<string, PipelineEvidence>();
  for (const raw of received) {
    const release = withRecordedReviewObservations(raw);
    if (sourceUrl && releaseProject(release.pipelineUrl) !== releaseProject(sourceUrl)) continue;
    // Numeric CI IDs are not globally unique; changed hash/commit is a distinct evidence version.
    const identity = JSON.stringify([release.pipelineUrl, release.commitSha, release.releaseSha256]);
    const prior = unique.get(identity);
    // Missing optional finding metadata does not erase an exact captured source record.
    unique.set(identity, release.reviewItems == null && prior?.reviewItems ? { ...release, reviewItems: prior.reviewItems } : release);
  }
  return [...unique.values()].sort((a, b) => releaseTime(a) - releaseTime(b));
}
export function rollupControlResults(releases: PipelineEvidence[], sourceUrl = releases[0]?.pipelineUrl): ControlRollupRow[] {
  const latest = new Map<string, ProvenResult>();
  const scoped = sourceUrl ? releases.filter(r => releaseProject(r.pipelineUrl) === releaseProject(sourceUrl)) : [];
  const cache:ReviewResultCache=new WeakMap();
  for (const release of [...scoped].sort((a, b) => releaseTime(a) - releaseTime(b))) {
    for (const [id, result] of evidenceForReleaseInternal(release, scoped, cache)) {
      // A new unaccepted finding cannot displace a retained evidence link.
      if (result.mappingStatus === "proposed" && latest.has(id) && latest.get(id)?.mappingStatus !== "proposed") continue;
      latest.set(id, result);
    }
  }
  return moderateControls().map(control => ({ ...control, result: latest.get(control.id) ?? null }));
}
export function recordedRows(rows: ControlRollupRow[]): ControlRollupRow[] { return rows.filter(row => row.result !== null && row.result.mappingStatus !== "proposed"); }

/** Map snapshots include earlier retained coverage, never evidence captured after the selected release. */
export function releasesAtSnapshot(history: PipelineEvidence[], selected: PipelineEvidence): PipelineEvidence[] {
  const scope = releaseProject(selected.pipelineUrl);
  return history.filter(record => releaseProject(record.pipelineUrl) === scope && releaseTime(record) <= releaseTime(selected));
}
