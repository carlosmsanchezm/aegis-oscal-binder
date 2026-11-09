import { createHash } from "node:crypto";
import { withPrInstallation, withScanInstallation } from "./auth";
import { assertRef } from "./client";
import { activeInstallationRepo } from "./store";
import { readConnection, retainEvent } from "../server/builder-store";
import { readRemediation, updateRemediationRecord } from "../aegis/remediation-store";
import { appendLog, readLog } from "../immutable-log";
import { storageKey } from "../storage-key";
import { AgentAccessError } from "../agent/agent-token";
import { containsSecret } from "../aegis/gates/redact";
import { sealCollectedArtifact } from "../collector/seal";
import { collectorEvents } from "../collector/events";
import { appendTimeline } from "../timeline/store";
import type { PullRequestLink } from "./pr-types";
export function isOwnGithubApp(value: {app?: {id?: number} | null} | undefined) {
  return value?.app?.id === Number(process.env.GITHUB_APP_ID);
}
export function isOwnPoamGateCheck(check: {name?: string; app?: {id?: number} | null} | undefined) {
  return check?.name === "aegis/poam-gate" && isOwnGithubApp(check);
}
export const prRecordKey = (id: string) => `binder.plan-proposals.v1:binder-connection:${id}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Locator = { sessionId: string; connectionId: string; poamItemId: string };
const index = (installationId: number, owner: string, repo: string) => storageKey(["github", "pr-index", hash(`${installationId}:${owner.toLowerCase()}/${repo.toLowerCase()}`)]) + "/";
export async function pullRequestLinks(sessionId: string, connectionId: string) {
  return (await readRemediation(sessionId))?.records.find(r => r.key === prRecordKey(connectionId))?.pullRequests ?? [];
}
export async function connectedPrRepo(connectionId: string) {
  const c = await readConnection(connectionId), g = c?.github;
  if (!c || c.revokedAt || !g || !await activeInstallationRepo(g.installationId, g.owner, g.repo))
    throw new AgentAccessError("Collect this connected repository through the server reader first.", 403, "scope");
  return g;
}
export type FixPrInput = { runnerAssignmentId?: string; poamItemId?: string; operation?: string; prUrl?: string; prNumber?: number; head?: string; base?: string; title?: string };
export async function proposeFixPr(sessionId: string, connectionId: string, actor: string, input: FixPrInput) {
  const g = await connectedPrRepo(connectionId);
  const { connectionProposals } = await import("../agent/approvals");
  const p = (await connectionProposals(connectionId, sessionId)).find(x => x.proposal.id === input.poamItemId)?.proposal;
  if (!p || p.closureConfirmed) throw new AgentAccessError("Select an open retained POA&M item in this connection.", 400, "invalid_request");
  const c = await readConnection(connectionId);
  const records = await (await import("../agent/service")).connectionRecords({connectionId, ownerHash: c!.ownerHash});
  const source = records.find(r => r.pipelineId === p.sourceReleaseId);
  if (source?.observation.subject.id.toLowerCase() !== `https://github.com/${g.owner}/${g.repo}`.toLowerCase()) throw new AgentAccessError("Finding belongs to a different repository.", 403, "scope");
  const previous = (await pullRequestLinks(sessionId, connectionId)).findLast(x => x.poamItemId === p.id);
  if (previous && (previous.state === "open" || !p.draft_revision || previous.draftRevision === p.draft_revision))
    throw new AgentAccessError("An item already has a PR link. Its identity cannot be replaced without a new draft revision.", 409, "invalid_request");
  let number = input.prNumber;
  if (input.prUrl) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(input.prUrl);
    if (!match || match[1].toLowerCase() !== g.owner.toLowerCase() || match[2].toLowerCase() !== g.repo.toLowerCase() || (number && number !== Number(match[3])))
      throw new AgentAccessError("PR must belong to this connected repository.", 400, "invalid_request");
    number = Number(match[3]);
  }
  const operation = input.operation ?? "register";
  if (operation !== "register" && operation !== "open") throw new AgentAccessError("Use register or open.", 400, "invalid_request");
  if (operation === "open") {
    if (process.env.AEGIS_GITHUB_PR_WRITE !== "true") throw new AgentAccessError("PR creation is disabled; register an existing PR.", 403, "scope");
    if (!input.head || !input.base || !input.title?.trim() || input.title.length > 200 || containsSecret(input.title))
      throw new AgentAccessError("Provide a head, base and credential-free title.", 400, "invalid_request");
    assertRef(input.head); assertRef(input.base);
  } else if (!Number.isSafeInteger(number) || number! <= 0) throw new AgentAccessError("Provide an existing PR number or URL.", 400, "invalid_request");
  const runner = await import("../agent/fix-runner");
  const assignment = runner.runnerEnabled() ? await runner.reserveFixProposal(sessionId, connectionId, actor, p.id, input.runnerAssignmentId, operation === "register", number) : null;
  if (assignment && assignment.draftRevision !== p.draft_revision) throw new AgentAccessError("POA&M revision changed; ask a person to revise the assignment.",409,"scope");
  if (assignment && operation === "open") {
    // Validate complete branch diff before Aegis opens a PR; agents cannot supply a file list.
    const files = await withScanInstallation(g.installationId, g.repo, async ({octokit}) => {
      const compared = await octokit.rest.repos.compareCommitsWithBasehead({owner:g.owner, repo:g.repo, basehead:`${input.base}...${input.head}`});
      if (!compared.data.files || compared.data.files.length >= 300 || compared.data.status !== "ahead") throw new Error("Complete bounded branch diff is required before opening a runner PR.");
      return compared.data.files.flatMap(f => f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]);
    });
    runner.assertFixFiles(assignment, files);
  }
  await appendTimeline(connectionId, {
    id: hash(JSON.stringify([p.id, p.draft_revision, operation, number, input.head, input.base])), kind: actor.startsWith("agent:") ? "agent-action" : "person-action",
    source: { repo: `https://github.com/${g.owner}/${g.repo}` }, commit: "", observedAt: new Date().toISOString(), artifactSha256: [], controls: [p.controlId], findings: [p.id.split(":").at(-1)!], items: [p.id], collected: false,
    reason_code: "fix_pr_" + operation + "_requested", summary: { operation, actor, poamItemId: p.id },
  });
  if (operation === "open") {
    number = await withPrInstallation(g.installationId, g.repo, "pr-open", async ({ octokit }) => {
      // Reuse an interrupted creation for this branch. No contents write or merge API exists here.
      const existing = await octokit.rest.pulls.list({ owner: g.owner, repo: g.repo, head: `${g.owner}:${input.head}`, base: input.base, state: "open" });
      if (existing.data.length) return existing.data[0].number;
      return (await octokit.rest.pulls.create({ owner: g.owner, repo: g.repo, head: input.head!, base: input.base!, title: input.title!, body: `Proposed remediation for POA&M ${p.id}. Human review and collected retest are required.` })).data.number;
    });
  }
  const snapshot = await readPrSnapshot(g, number!);
  if (assignment) runner.assertFixFiles(assignment, await readPrFiles(g, number!, snapshot.headSha));
  const now = new Date().toISOString();
  const link: PullRequestLink = { schema: "binder.pull-request-link.v1", poamItemId: p.id, findingId: p.id.split(":").at(-1)!, sourceReleaseId: p.sourceReleaseId, draftRevision: p.draft_revision, connectionId, ...g,
    ...snapshot, createdBy: actor, createdAt: now, updatedAt: now };
  if (assignment) await runner.attachFixPr(sessionId, connectionId, assignment.id, link);
  const locator = { sessionId, connectionId, poamItemId: p.id };
  await appendLog(index(g.installationId, g.owner, g.repo), locator, x => JSON.stringify(x) === JSON.stringify(locator));
  await updateRemediationRecord(sessionId, prRecordKey(connectionId), async record => {
    if (!record) throw new Error("POA&M record unavailable.");
    const current = record.pullRequests?.findLast(x => x.poamItemId === p.id);
    if (current && JSON.stringify(current) !== JSON.stringify(previous)) throw new Error("PR link changed; reload the item.");
    await recordPrFacts(link, operation);
    return { ...record, pullRequests: [...(record.pullRequests ?? []), link] };
  }, undefined, true);
  await (await import("./poam-gate")).refreshConnectionGates(sessionId, connectionId);
  return { pullRequest: link, closureConfirmed: false };
}
type PrRepo={installationId:number;owner:string;repo:string};
export async function readPrSnapshot(g:PrRepo,number:number){return (await readPrSnapshots(g,[number]))[0];}
/** One transient credential covers the complete bounded repository snapshot batch. */
export async function readPrSnapshots(g:PrRepo,numbers:readonly number[]){
  if(numbers.length>100||new Set(numbers).size!==numbers.length||numbers.some(n=>!Number.isSafeInteger(n)||n<=0))throw new Error("A complete bounded PR number inventory is required.");
  if(!numbers.length)return [];
  return withPrInstallation(g.installationId,g.repo,"pr-read",async client=>{
    const results=await Promise.allSettled(numbers.map(number=>readPrWithClient(g,number,client)));
    const failed=results.find(result=>result.status==="rejected");
    if(failed?.status==="rejected")throw failed.reason;
    return results.map(result=>{if(result.status!=="fulfilled")throw new Error("Incomplete PR snapshot batch.");return result.value;});
  });
}
async function readPrWithClient(g:PrRepo,number:number,{octokit}:import("./auth").InstallationClient){
    const pr = (await octokit.rest.pulls.get({ owner: g.owner, repo: g.repo, pull_number: number })).data;
    if (pr.base.repo.full_name.toLowerCase() !== `${g.owner}/${g.repo}`.toLowerCase() || pr.number !== number || !/^[a-f0-9]{40}$/.test(pr.head.sha) || !/^[a-f0-9]{40}$/.test(pr.base.sha)) throw new Error("PR repository or commit mismatch.");
    const state = pr.merged ? "merged" as const : pr.state === "closed" ? "closed" as const : "open" as const;
    if (state === "merged" && !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? "")) throw new Error("Merged commit unavailable.");
    const sha = state === "merged" ? pr.merge_commit_sha! : pr.head.sha;
    const checks = await octokit.paginate(octokit.rest.checks.listForRef, { owner: g.owner, repo: g.repo, ref: sha, filter: "latest", per_page: 100 }, response => {
      if (response.data.total_count > 1000) throw new Error("CI inventory exceeds the bounded check limit.");
      return response.data;
    });
    const relevant = checks.filter(c => !isOwnPoamGateCheck(c));
    const runs = relevant.flatMap(c => {
      const url = c.html_url;
      if (!url || !url.startsWith("https://github.com/")) return [];
      const run = /\/actions\/runs\/([1-9][0-9]*)/.exec(url);
      return [{id: run?.[1] ?? String(c.id), url: run ? url.slice(0, url.indexOf(run[0])) + "/actions/runs/" + run[1] : url}];
    }).filter((run, i, all) => all.findIndex(other => other.url === run.url) === i);
    const ci = relevant.some(c => c.status === "completed" && c.conclusion !== "success") ? "failure" as const : relevant.length && relevant.every(c => c.status === "completed" && c.conclusion === "success") ? "success" as const : "pending" as const;
    return { prNumber: number, prUrl: `https://github.com/${g.owner}/${g.repo}/pull/${number}`, headSha: pr.head.sha, baseSha: pr.base.sha, state,
      ...(state === "merged" ? { mergedCommitSha: pr.merge_commit_sha! } : {}), ciStatus: { sha, state: ci, checks: relevant.length, checkedAt: new Date().toISOString(), ...(runs.length ? {runs} : {}) } };
 }
/** Signed events are triggers; current GitHub state is re-read to handle replay and out-of-order delivery. */
export async function applyPrWebhook(event: string, body: unknown, gateRefresh?: {prNumbers: readonly number[]}) {
  if (!["pull_request", "check_run", "workflow_run", "check_suite"].includes(event)) return;
  const b = body as { installation?: {id?: number}; repository?: {owner?: {login?: string}; name?: string}; pull_request?: {number?: number}; check_run?: {name?: string; app?: {id?: number}}; check_suite?: {app?: {id?: number}}; action?: string };
  if ((event === "check_run" && isOwnPoamGateCheck(b.check_run)) || (event === "check_suite" && isOwnGithubApp(b.check_suite))) return;
  const installationId = b.installation?.id, owner = b.repository?.owner?.login, repo = b.repository?.name;
  if (!installationId || !owner || !repo || !await activeInstallationRepo(installationId, owner, repo)) return;
  const cache = new Map<number, Awaited<ReturnType<typeof readPrSnapshot>>>();
  const linksBySession = new Map<string, Awaited<ReturnType<typeof pullRequestLinks>>>();
  const affected=new Map<string,{sessionId:string;connectionId:string}>();
  for (const row of await readLog<Locator>(index(installationId, owner, repo))) {
    const {sessionId, connectionId, poamItemId} = row.body;
    const c = await readConnection(connectionId);
    if (!c || c.revokedAt || c.github?.installationId !== installationId) continue;
    // Gate refresh concerns current open PRs. Do not re-evaluate the complete
    // shipped release and every historical PR before evaluating their heads.
    const key=sessionId+":"+connectionId;
    let existing=linksBySession.get(key);
    if(!existing){existing=await pullRequestLinks(sessionId,connectionId);linksBySession.set(key,existing);}
    const target=existing.findLast(x=>x.poamItemId===poamItemId);
    if(!target || (event==="pull_request" && b.pull_request?.number!==target.prNumber) ||
      (gateRefresh && !gateRefresh.prNumbers.includes(target.prNumber))) continue;
    await updateRemediationRecord(sessionId, prRecordKey(connectionId), async record => {
      if (!record) throw new Error("PR link record unavailable.");
      const links = [...(record.pullRequests ?? [])];
      // Closed-link history remains immutable; only the latest revision is refreshed.
      const position = links.findLastIndex(x => x.poamItemId === poamItemId && x.installationId === installationId && x.owner.toLowerCase() === owner.toLowerCase() && x.repo.toLowerCase() === repo.toLowerCase());
      const link = links[position];
      if (!link || (event === "pull_request" && b.pull_request?.number !== link.prNumber)) return record;
      let snapshot = cache.get(link.prNumber);
      if (!snapshot) { snapshot = await readPrSnapshot({installationId, owner, repo}, link.prNumber); cache.set(link.prNumber, snapshot); }
      if (link.state === "merged" && (snapshot.state !== "merged" || snapshot.mergedCommitSha !== link.mergedCommitSha)) throw new Error("Merged PR identity cannot change.");
      const updated = {...link, ...snapshot, updatedAt: new Date().toISOString()};
      // Freshness belongs to the current projection. Replayed unchanged metadata
      // must not exhaust the bounded collector history with identical facts.
      const material = (value: PullRequestLink) => JSON.stringify([value.state,value.headSha,value.baseSha,value.mergedCommitSha,{...value.ciStatus,checkedAt:undefined}]);
      if(material(link)!==material(updated))await recordPrFacts(updated, "refresh");
      links[position] = updated;
      return {...record, pullRequests: links};
    }, undefined, true);
    affected.set(sessionId+":"+connectionId,{sessionId,connectionId});
  }
  for(const {sessionId,connectionId} of affected.values()){
    await (await import("../agent/retest")).satisfyCollectedRetests(sessionId, connectionId);
    if (!gateRefresh && (await readRemediation(sessionId))?.records.find(r => r.key === prRecordKey(connectionId))?.releaseEvidence?.length)
      await (await import("../server/release-evidence")).formReleaseEvidence(sessionId, connectionId);
    await (await import("../agent/fix-runner")).refreshFixRunner(sessionId, connectionId);
  }
}
/** Safe facts use the standard collector pipeline and existing relevance mappings. No raw webhook is retained. */
export async function recordPrFacts(link: PullRequestLink, action: string, gate?: "success" | "failure") {
  const sha = link.mergedCommitSha ?? link.headSha;
  const safe = { pr: link.prNumber, state: link.state, ci: link.ciStatus.state, sha, action, gate, item: hash(link.poamItemId) };
  const digest = hash(JSON.stringify(safe));
  const fields = { ...(gate ? {gate} : {}), pr: link.prNumber, state: link.state, ci: link.ciStatus.state, commit: sha, item: hash(link.poamItemId) };
  const artifact = sealCollectedArtifact({ schema: "aegis.collected-artifact.v1", name: `source-${digest.slice(0,24)}.json`, type: "change-control",
    source: {repo: `https://github.com/${link.owner}/${link.repo}`, commit: sha, path: `pulls/${link.prNumber}`, sha256: digest}, capturedAt: link.updatedAt, sha256: "0".repeat(64),
    facts: Object.entries(fields).map(([field,value]) => ({key: "change-control", field, value, content: `${field} = ${value}`, line: 1})),
    limitations: ["PR and CI state is server-read metadata, not scanner retest proof or human approval.", "Connecting a repository does not authorize processing agency evidence."] });
  for (const event of collectorEvents([artifact])) {
    const parsed = JSON.parse(event.rawEvent); parsed.run.id = `pr-${digest.slice(0,24)}-${hash(link.updatedAt).slice(0,10)}`;
    await retainEvent(link.connectionId, JSON.stringify(parsed), undefined, "browser-owner", true);
  }
  await appendTimeline(link.connectionId, { id: `pr-${digest}-${link.updatedAt}`, kind: "monitoring-capture", source: {repo: `https://github.com/${link.owner}/${link.repo}`, url: link.prUrl}, commit: sha, observedAt: link.updatedAt,
    artifactSha256: [artifact.sha256], controls: ["CM-3"], findings: [link.findingId], items: [link.poamItemId], collected: true, reason_code: "fix_pr_" + action, summary: {prNumber: link.prNumber, state: link.state, ci: link.ciStatus.state, createdBy: link.createdBy} });
}

/** Private routing metadata; never returned from a browser/agent endpoint. */
export async function prLocators(installationId: number, owner: string, repo: string) {
  return (await readLog<Locator>(index(installationId, owner, repo))).map(x => x.body);
}
export async function indexPrLink(link: PullRequestLink, sessionId: string) {
  const locator = {sessionId, connectionId: link.connectionId, poamItemId: link.poamItemId};
  await appendLog(index(link.installationId, link.owner, link.repo), locator, x => JSON.stringify(x) === JSON.stringify(locator));
}

/** Bound complete inventory, including rename sources, to the observed head. */
export async function readPrFiles(g: {installationId:number;owner:string;repo:string}, number: number, head: string) {
  return withPrInstallation(g.installationId, g.repo, "pr-read", async ({octokit}) => {
    const before = (await octokit.rest.pulls.get({owner:g.owner,repo:g.repo,pull_number:number})).data;
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {owner:g.owner,repo:g.repo,pull_number:number,per_page:100});
    const after = (await octokit.rest.pulls.get({owner:g.owner,repo:g.repo,pull_number:number})).data;
    if (before.head.sha !== head || after.head.sha !== head || files.length !== before.changed_files || files.length > 3000) throw new Error("Complete PR inventory on the bound head is required.");
    return files.flatMap(f => f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]);
  });
}
