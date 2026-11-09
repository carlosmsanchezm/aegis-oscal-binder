import { createHash, randomUUID } from "node:crypto";
import { appendLogComputed, readLog, type Chained } from "../immutable-log";
import { storageKey } from "../storage-key";
import { AgentAccessError } from "./agent-token";
import { connectedPrRepo } from "../github/pull-requests";
import { appendTimeline, queryTimeline } from "../timeline/store";
import type { PullRequestLink } from "../github/pr-types";

export const runnerEnabled = () => process.env.AEGIS_FIX_RUNNER === "true";
export function runnerLimit() {
  const raw = process.env.AEGIS_FIX_RUNNER_LIMIT ?? "5";
  if (!/^(?:[1-9]|10)$/.test(raw)) throw new Error("AEGIS_FIX_RUNNER_LIMIT must be an integer from 1 to 10.");
  return Number(raw);
}
/** Pre-PR leases only. Uncertain provider operations never expire. */
export function runnerLeaseMs() {
  const raw = process.env.AEGIS_FIX_RUNNER_TTL_SECONDS ?? "900";
  if (!/^\d+$/.test(raw) || Number(raw) < 60 || Number(raw) > 7200) throw new Error("Runner TTL must be 60 to 7200 seconds.");
  return Number(raw) * 1000;
}
function renew(job: FixAssignment, at: string) {
  job.progressAt = at;
  job.leaseExpiresAt = new Date(Date.parse(at) + runnerLeaseMs()).toISOString();
}
export function expireFixes(jobs: FixAssignment[], at: string): Change[] {
  const changes: Change[] = [];
  for (const job of jobs) {
    // Legacy reservations receive a lease based on their original dispatch, never an immortal fallback.
    const deadline = job.leaseExpiresAt ?? new Date(Date.parse(job.dispatchedAt ?? job.queuedAt) + runnerLeaseMs()).toISOString();
    if (["reserved", "claimed"].includes(job.state) && Date.parse(deadline) <= Date.parse(at)) {
      job.state = "expired";
      changes.push({id: randomUUID(), kind: "lease_expired", assignmentId: job.id});
    }
  }
  return changes;
}
export type FixAssignment = {
  batchId: string; id: string; sessionId: string; connectionId: string; poamItemId: string; findingId: string;
  sourceReleaseId: string; draftRevision?: string; control: string;
  paths: string[]; resources: string[]; tokenId?: string;
  state: "queued" | "reserved" | "claimed" | "proposing" | "pr-open" | "merged" | "closed" | "abandoned" | "expired";
  leaseExpiresAt?: string; progressAt?: string;
  waitReason?: "capacity" | "overlap"; queuedAt: string; dispatchedAt?: string;
  prNumber?: number; head?: string; readyForClosureReview: boolean;
};
type Change = { id: string; kind: string; assignmentId: string };
export type RunnerRecord = {
  schema: "binder.fix-runner.v1"; id: string; at: string; limit: number;
  assignments: FixAssignment[]; changes: Change[];
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const inFlight = (job: FixAssignment) => ["reserved", "claimed", "proposing", "pr-open"].includes(job.state);
function pathOverlap(a: string, b: string) {
  return a === "**" || b === "**" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
export function scopesOverlap(a: Pick<FixAssignment, "paths" | "resources">, b: Pick<FixAssignment, "paths" | "resources">) {
  return a.paths.some(p => b.paths.some(q => pathOverlap(p, q))) || a.resources.some(r => b.resources.includes(r));
}
export function safeFixPath(value: string) {
  if (value === "**") return value;
  if (!value || value.length > 1000 || /[\u0000-\u0020\\:*?]/.test(value) || value.startsWith("/") || value.split("/").some(p => !p || p === "." || p === ".."))
    throw new AgentAccessError("Fix paths must be literal repository-relative paths.", 400, "invalid_request");
  return value;
}
/** FIFO among runnable items; blocked scopes do not starve unrelated work. */
export function scheduleFixes(jobs: FixAssignment[], limit: number, at: string): Change[] {
  const changes: Change[] = [];
  for (const job of jobs.filter(j => j.state === "queued")) {
    const live = jobs.filter(inFlight);
    const reason = live.some(other => scopesOverlap(job, other)) ? "overlap" : live.length >= limit ? "capacity" : undefined;
    if (reason) {
      if (job.waitReason !== reason) changes.push({id: randomUUID(), kind: reason === "overlap" ? "overlap_deferred" : "queue_wait", assignmentId: job.id});
      job.waitReason = reason;
    } else {
      job.state = "reserved"; job.dispatchedAt = at; renew(job, at); delete job.waitReason;
      changes.push({id: randomUUID(), kind: "dispatched", assignmentId: job.id});
    }
  }
  return changes;
}
async function prefix(connectionId: string) {
  const g = await connectedPrRepo(connectionId);
  // One journal per installation/repository: different connections/sessions cannot double-reserve.
  return storageKey(["fix-runner", digest(`${g.installationId}:${g.owner.toLowerCase()}/${g.repo.toLowerCase()}`)]) + "/";
}
async function audit(rows: Chained<RunnerRecord>[], sessionId: string, connectionId: string) {
  const applied = new Set((await queryTimeline(connectionId)).map(row=>row.body.id));
  for (const row of rows) for (const change of row.body.changes) {
    if (applied.has("fix-runner:" + change.id)) continue;
    const job = row.body.assignments.find(j => j.id === change.assignmentId);
    if (!job || job.sessionId !== sessionId || job.connectionId !== connectionId) continue;
    await appendTimeline(connectionId, {id: "fix-runner:" + change.id, kind: job.tokenId ? "agent-action" : "person-action", source: {}, commit: "", observedAt: row.body.at,
      artifactSha256: [], controls: [job.control], findings: [job.findingId], items: [job.poamItemId], collected: false,
      reason_code: "fix_runner_" + change.kind, summary: {assignment: job.id, state: job.state, paths: job.paths, resources: job.resources}});
  }
}
async function transition(sessionId: string, connectionId: string, mutate: (jobs: FixAssignment[], at: string) => Change[], schedule = true) {
  if (!runnerEnabled()) throw new AgentAccessError("Parallel fix runner is disabled.", 403, "scope");
  if (process.env.AEGIS_GITHUB_POAM_GATE !== "true") throw new AgentAccessError("Enable the POA&M gate before dispatching fixes.", 403, "scope");
  const key = await prefix(connectionId), id = randomUUID(), at = new Date().toISOString(), limit = runnerLimit();
  const row = await appendLogComputed<RunnerRecord>(key, entries => {
    const jobs = structuredClone(entries.at(-1)?.body.assignments ?? []);
    const changes = expireFixes(jobs, at);
    changes.push(...mutate(jobs, at));
    if (jobs.length > 500) throw new Error("Runner history limit reached; use a new demo repository.");
    if (schedule) changes.push(...scheduleFixes(jobs, limit, at));
    const live = jobs.filter(inFlight);
    const priorLive = entries.at(-1)?.body.assignments.filter(inFlight).length ?? 0;
    if (live.length > Math.max(limit, priorLive)) throw new Error("Concurrent dispatch exceeded runner capacity.");
    if (live.some((job,i) => live.slice(i+1).some(other => scopesOverlap(job, other)))) throw new AgentAccessError("An externally reopened PR conflicts with an active assignment; keep it gated and reconcile with a person.",409,"scope");
    return {schema: "binder.fix-runner.v1", id, at, limit, assignments: jobs, changes};
  }, body => body.id === id,undefined,(previous,next)=>
    next.changes.length===0&&previous.limit===next.limit&&JSON.stringify(previous.assignments)===JSON.stringify(next.assignments));
  await audit(await readLog<RunnerRecord>(key), sessionId, connectionId);
  // A reused snapshot carries no changes from this operation. In particular,
  // a no-op claim must never return a previous worker's successful claim.
  return row.body.id===id?row.body:{...row.body,changes:[]};
}
function own(jobs: FixAssignment[], id: string | undefined, sessionId: string, connectionId: string) {
  const job = jobs.find(j => j.id === id && j.sessionId === sessionId && j.connectionId === connectionId);
  if (!job) throw new AgentAccessError("A dispatched assignment in this session and connection is required.", 409, "scope");
  return job;
}
function view(record: RunnerRecord | undefined, sessionId: string, connectionId: string) {
  const assignments = (record?.assignments ?? []).filter(j => j.sessionId === sessionId && j.connectionId === connectionId).map(({sessionId: _session, ...job}) => job);
  return {enabled: runnerEnabled(), limit: runnerLimit(), assignments, humanClosureRequired: true};
}
/** Verified scheduling state; internal scope checks do not need closure views. */
async function runnerSnapshot(sessionId: string, connectionId: string) {
  let rows = await readLog<RunnerRecord>(await prefix(connectionId));
  if (runnerEnabled() && rows.at(-1)?.body.assignments.some(j => ["reserved", "claimed"].includes(j.state) && Date.parse(j.leaseExpiresAt ?? new Date(Date.parse(j.dispatchedAt ?? j.queuedAt) + runnerLeaseMs()).toISOString()) <= Date.now())) {
    await transition(sessionId, connectionId, () => []);
    rows=await readLog<RunnerRecord>(await prefix(connectionId));
  }
  await audit(rows, sessionId, connectionId);
  return view(rows.at(-1)?.body, sessionId, connectionId);
}
export async function getFixRunner(sessionId: string, connectionId: string) {
  const result=await runnerSnapshot(sessionId,connectionId);
  for (const job of result.assignments.filter(j => j.readyForClosureReview)) {
    job.readyForClosureReview = (await (await import("../aegis/collected-closure")).collectedScannerProof(sessionId,job.sourceReleaseId,job.findingId,connectionId)).ready;
  }
  return result;
}
/** Human starts a batch. Agents receive retained item/scope assignments; they cannot author locks. */
export async function enqueueFixes(sessionId: string, connectionId: string, itemIds: string[]) {
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 50 || itemIds.some(id => typeof id !== "string"))
    throw new AgentAccessError("Select from 1 to 50 retained POA&M items.", 400, "invalid_request");
  const { connectionProposals } = await import("./approvals"), { connectionRecords } = await import("./service"), {readConnection} = await import("../server/builder-store");
  const connection = await readConnection(connectionId), proposals = await connectionProposals(connectionId, sessionId);
  const records = await connectionRecords({connectionId, ownerHash: connection!.ownerHash});
  const g = await connectedPrRepo(connectionId);
  const trusted = new Set((await (await import("../collector/trusted-release")).trustedReleases(sessionId,connectionId)).map(r=>r.releaseSha256));
  const batchId = randomUUID();
  const jobs: FixAssignment[] = itemIds.map(id => {
    const p = proposals.find(x => x.proposal.id === id)?.proposal;
    const release = records.find(r => r.pipelineId === p?.sourceReleaseId), issue = release?.reviewItems?.find(i => p?.id.endsWith(":" + i.id));
    if (!p || p.closureConfirmed || !release || !issue || release.observation.subject.id.toLowerCase() !== `https://github.com/${g.owner}/${g.repo}`.toLowerCase())
      throw new AgentAccessError("Select open retained items from this connected repository.", 400, "invalid_request");
    const artifacts = (release.collectedArtifacts ?? []).filter(a => issue.scope.artifacts.includes(a.name));
    // Scanner reports need explicit target paths. Unknown scope reserves the whole repository.
    const paths = !trusted.has(release.releaseSha256) ? ["**"] : issue.scope.fixPaths?.length ? issue.scope.fixPaths.map(safeFixPath) : artifacts.length && artifacts.every(a => a.source.kind !== "scan-result" && a.source.kind !== "aws-account") ? artifacts.map(a => safeFixPath(a.source.path)) : ["**"];
    const resources = [...new Set(issue.scope.resourceIds ?? (issue.scope.fixPaths?.length ? [] : [issue.scope.asset]))].filter(Boolean);
    return {batchId, id: randomUUID(), sessionId, connectionId, poamItemId: p.id, findingId: issue.id, sourceReleaseId: release.pipelineId,
      draftRevision: p.draft_revision, control: p.controlId, paths: [...new Set(paths)], resources, state: "queued", queuedAt: new Date().toISOString(), readyForClosureReview: false};
  });
  // Retain automatically generated plans on the existing record so their PR link has a durable home.
  const {updateRemediationRecord} = await import("../aegis/remediation-store");
  await updateRemediationRecord(sessionId, `binder.plan-proposals.v1:binder-connection:${connectionId}`, async current => {
    const base = current ?? {key:`binder.plan-proposals.v1:binder-connection:${connectionId}`, assessment:null, assessments:{}, plans:[]};
    return {...base, issueDrafts:[...(base.issueDrafts ?? []), ...proposals.filter(x => itemIds.includes(x.proposal.id) && !base.issueDrafts?.some(p => (p as {id:string}).id === x.proposal.id)).map(x => x.proposal)]};
  });
  // Reconcile terminal PRs before adding another batch, never from caller-supplied state.
  await refreshFixRunner(sessionId, connectionId);
  const result = await transition(sessionId, connectionId, current => {
    const changes: Change[] = [];
    for (const job of jobs) {
      const existing = current.find(j => j.sessionId === sessionId && j.connectionId === connectionId && j.poamItemId === job.poamItemId && j.draftRevision === job.draftRevision && !(["abandoned", "expired"].includes(j.state)));
      if (existing) continue;
      current.push(structuredClone(job)); changes.push({id: randomUUID(), kind: "queued", assignmentId: job.id});
    }
    return changes;
  });
  return view(result, sessionId, connectionId);
}
export async function claimFix(sessionId: string, connectionId: string, tokenId: string) {
  const result = await transition(sessionId, connectionId, (jobs, at) => {
    const job = jobs.find(j => j.sessionId === sessionId && j.connectionId === connectionId && j.state === "reserved");
    if (!job) return [];
    job.tokenId = tokenId; job.state = "claimed"; renew(job, at);
    return [{id: randomUUID(), kind: "claimed", assignmentId: job.id}];
  }, false);
  const change = result.changes.find(c => c.kind === "claimed"), job = result.assignments.find(j => j.id === change?.assignmentId);
  if (!job) return {assignment: null};
  const {sessionId: _session, ...safe} = job;
  return {assignment: safe, humanClosureRequired: true};
}
export async function reserveFixProposal(sessionId: string, connectionId: string, actor: string, itemId: string, assignmentId?: string, recovery = false, recoveryPrNumber?: number) {
  const result = await transition(sessionId, connectionId, jobs => {
    const job = own(jobs, assignmentId, sessionId, connectionId);
    if (job.poamItemId !== itemId || (actor.startsWith("agent:") && job.tokenId !== actor.slice(6)) || !(["reserved", "claimed"].includes(job.state) || (recovery && (job.state === "proposing" || (job.state === "pr-open" && job.prNumber === recoveryPrNumber)))))
      throw new AgentAccessError("The assignment is queued, belongs to another agent, or already has a PR operation. Recover uncertain creation by registering its PR.", 409, "scope");
    job.state = "proposing";
    return [{id: randomUUID(), kind: "pr_requested", assignmentId: job.id}];
  }, false);
  return own(result.assignments, assignmentId, sessionId, connectionId);
}
export function assertFixFiles(job: Pick<FixAssignment, "paths">, files: string[]) {
  if (!files.length || files.length > 3000 || files.some(file => !job.paths.some(p => p === "**" || file === p || file.startsWith(p + "/"))))
    throw new AgentAccessError("PR files exceed the assignment's reserved scope. Keep the PR gated and revise its scope with a person.", 409, "scope");
}
export async function attachFixPr(sessionId: string, connectionId: string, assignmentId: string, link: PullRequestLink) {
  await transition(sessionId, connectionId, jobs => {
    const job = own(jobs, assignmentId, sessionId, connectionId);
    if (job.poamItemId !== link.poamItemId || job.draftRevision !== link.draftRevision || (job.prNumber && job.prNumber !== link.prNumber)) throw new Error("PR does not match the reserved assignment.");
    if (jobs.some(j => j.id !== job.id && j.prNumber === link.prNumber)) throw new Error("Each assignment must have its own PR.");
    job.prNumber = link.prNumber; job.head = link.headSha; job.state = link.state === "open" ? "pr-open" : link.state;
    return [{id: randomUUID(), kind: "pr_" + link.state, assignmentId: job.id}, ...(link.state === "open" ? [{id:randomUUID(),kind:"gate_pending",assignmentId:job.id}] : [])];
  });
}
export async function refreshFixRunner(sessionId: string, connectionId: string) {
  if (!runnerEnabled()) return;
  const current = await runnerSnapshot(sessionId, connectionId);
  if (!current.assignments.length) return;
  const {pullRequestLinks, readPrSnapshots} = await import("../github/pull-requests"), g = await connectedPrRepo(connectionId);
  const links = await pullRequestLinks(sessionId, connectionId);
  const selected=links.filter(l => current.assignments.some(j => j.poamItemId === l.poamItemId && j.draftRevision === l.draftRevision));
  const read=await readPrSnapshots(g,[...new Set(selected.map(l=>l.prNumber))]);
  const snapshots=selected.map(link=>{
    const snapshot=read.find(snapshot=>snapshot.prNumber===link.prNumber);
    if(!snapshot)throw new Error("Complete fresh PR snapshot inventory is required.");
    return {...link,...snapshot};
  });
  const {collectedScannerProof} = await import("../aegis/collected-closure");
  const proofs = new Map(await Promise.all(snapshots.map(async link => [link.poamItemId, link.state === "merged" && (await collectedScannerProof(sessionId, link.sourceReleaseId, link.findingId, connectionId)).ready] as const)));
  const result = await transition(sessionId, connectionId, jobs => {
    const changes: Change[] = [];
    for (const job of jobs.filter(j => j.sessionId === sessionId && j.connectionId === connectionId && j.state !== "abandoned")) {
      const link = snapshots.find(l => l.poamItemId === job.poamItemId && l.draftRevision === job.draftRevision);
      if (!link) continue;
      const state = link.state === "open" ? "pr-open" : link.state;
      if (job.state !== state) {job.state = state; job.prNumber = link.prNumber; changes.push({id: randomUUID(), kind: "pr_" + link.state, assignmentId: job.id});}
      const ready = proofs.get(job.poamItemId) ?? false;
      if (ready !== job.readyForClosureReview) {job.readyForClosureReview = ready; changes.push({id: randomUUID(), kind: ready ? "ready_for_closure_review" : "closure_proof_pending", assignmentId: job.id});}
    }
    return changes;
  });
  return view(result, sessionId, connectionId);
}
/** A person may abandon work only before a PR operation starts. Uncertain/open PRs retain locks. */
export async function abandonFix(sessionId: string, connectionId: string, assignmentId: string) {
  return view(await transition(sessionId, connectionId, jobs => {
    const job = own(jobs, assignmentId, sessionId, connectionId);
    if (!["queued", "reserved", "claimed"].includes(job.state)) throw new AgentAccessError("Reconcile and close the provider PR before releasing this assignment.", 409, "needs_human");
    job.state = "abandoned";
    return [{id: randomUUID(), kind: "abandoned", assignmentId: job.id}];
  }), sessionId, connectionId);
}
/** Owner-only recovery of a definite provider validation refusal, never an uncertain write. */
export async function retryRejectedOpen(sessionId: string, connectionId: string, assignmentId: string) {
  const job = (await getFixRunner(sessionId, connectionId)).assignments.find(j => j.id === assignmentId);
  if (!job || job.state !== "proposing" || job.prNumber || !job.tokenId)
    throw new AgentAccessError("Only a rejected pre-PR operation can be retried.", 409, "needs_human");
  const entries = await (await import("./audit")).getAgentActivity(connectionId);
  const last = entries.findLast(({body}) => body.tool === "propose_fix_pr" && body.tokenId === job.tokenId &&
    (body.inputs as {runnerAssignmentId?: string})?.runnerAssignmentId === assignmentId)?.body;
  const input = last?.inputs as {operation?: string; head?: string; base?: string} | undefined;
  if (last?.result !== "error" || last.refusalCode !== "operation_failed" || last.refusalReason !== "GitHub request failed with HTTP 422." ||
    input?.operation !== "open" || !input.head || !input.base)
    throw new AgentAccessError("A retained definitive GitHub 422 refusal is required; uncertain operations retain their locks.", 409, "needs_human");
  const {assertRef} = await import("../github/client");assertRef(input.head);assertRef(input.base);
  const g = await connectedPrRepo(connectionId);
  const existing = await (await import("../github/auth")).withPrInstallation(g.installationId, g.repo, "pr-read", async ({octokit}) =>
    (await octokit.rest.pulls.list({owner:g.owner,repo:g.repo,head:`${g.owner}:${input.head}`,base:input.base,state:"all",per_page:1})).data);
  if (existing.length) throw new AgentAccessError("A provider PR exists; register it before retrying this assignment.", 409, "needs_human");
  return view(await transition(sessionId, connectionId, (jobs, at) => {
    const current = own(jobs, assignmentId, sessionId, connectionId);
    if (current.state !== "proposing" || current.prNumber || current.tokenId !== job.tokenId)
      throw new AgentAccessError("Assignment changed during provider reconciliation.", 409, "scope");
    current.state = "claimed";renew(current, at);
    return [{id:randomUUID(),kind:"rejected_open_retried",assignmentId}];
  }), sessionId, connectionId);
}
/** Gate enforcement also covers later pushes/renames outside the originally reserved files. */
export async function checkRunnerPrFiles(sessionId: string, connectionId: string, link: PullRequestLink, files: string[]) {
  if (!runnerEnabled() || link.emergency) return;
  const jobs = (await runnerSnapshot(sessionId, connectionId)).assignments;
  const job = jobs.find(j => j.poamItemId === link.poamItemId && j.draftRevision === link.draftRevision && j.prNumber === link.prNumber && j.state !== "abandoned");
  if (!job || !inFlight(job as FixAssignment)) throw new AgentAccessError("PR has no active runner assignment.", 409, "scope");
  assertFixFiles(job, files);
}

/** Explicit worker progress; owner reads and polling without an assignment cannot prolong locks. */
export async function renewFix(sessionId: string, connectionId: string, tokenId: string, assignmentId: string) {
  await transition(sessionId, connectionId, (jobs, at) => {
    const job = own(jobs, assignmentId, sessionId, connectionId);
    if (job.tokenId !== tokenId || job.state !== "claimed") throw new AgentAccessError("Only the claiming worker can renew an active pre-PR lease.", 409, "scope");
    renew(job, at);
    return [{id: randomUUID(), kind: "progress", assignmentId: job.id}];
  });
}
