import { AegisError } from "../errors";
import { accountKey, accountRead, accountWrite } from "@/lib/account/io";
import { appendEntry, assertAppendOnly, emptyChain, sealEntry, verifyChain } from "./audit";
import type { AgentRunRecord } from "./agent-run";
import type { AuditBody, AuditChain, Decision, GateCase } from "./types";

const WORKSPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAN_ID = /^[A-Za-z0-9._-]{1,80}$/;
const tails = new Map<string, Promise<unknown>>();

export function gateAuditKey(workspaceId: string): string {
  return accountKey("gates", requireWorkspace(workspaceId), "audit.json");
}

export function gateCaseKey(workspaceId: string, planId: string): string {
  if (!PLAN_ID.test(planId)) throw new AegisError("BAD_REQUEST", "Plan id is not usable.", 400);
  return accountKey("gates", requireWorkspace(workspaceId), "cases", `${planId}.json`);
}

export function agentRunKey(workspaceId: string, runId: string): string {
  if (!PLAN_ID.test(runId)) throw new AegisError("BAD_REQUEST", "Run id is not usable.", 400);
  return accountKey("gates", requireWorkspace(workspaceId), "agent-runs", `${runId}.json`);
}

function requireWorkspace(workspaceId: string): string {
  if (!WORKSPACE.test(workspaceId)) throw new AegisError("BAD_REQUEST", "Workspace id is not usable.", 400);
  return workspaceId;
}

function enqueue<T>(workspaceId: string, job: () => Promise<T>): Promise<T> {
  const previous = tails.get(workspaceId) ?? Promise.resolve();
  const run = previous.then(job, job);
  tails.set(workspaceId, run.then(() => undefined, () => undefined));
  return run;
}

export async function readGateAudit(workspaceId: string, root?: string): Promise<AuditChain> {
  const raw = await accountRead(gateAuditKey(workspaceId), root);
  if (!raw) return emptyChain(workspaceId);
  const chain = parseChain(raw, workspaceId);
  const verified = verifyChain(chain);
  if (!verified.ok) throw new AegisError("AUDIT_TAMPER", `Gate audit failed verification at ${verified.index}.`, 409);
  return chain;
}

export async function readGateCase(workspaceId: string, planId: string, root?: string): Promise<GateCase | null> {
  const raw = await accountRead(gateCaseKey(workspaceId, planId), root);
  if (!raw) return null;
  const gateCase = parseCase(raw);
  if (gateCase.workspaceId !== workspaceId || gateCase.planId !== planId) {
    throw new AegisError("AUDIT_TAMPER", "Gate case does not match its key.", 409);
  }
  const chain = await readGateAudit(workspaceId, root);
  const head = chain.entries.at(-1)?.hash;
  if (gateCase.auditLength !== chain.entries.length || gateCase.auditHead !== (head ?? gateCase.auditHead)) {
    throw new AegisError("AUDIT_TAMPER", "Gate case does not match the audit head.", 409);
  }
  if (chain.entries.length === 0 && gateCase.auditLength !== 0) {
    throw new AegisError("AUDIT_TAMPER", "Gate case does not match the audit head.", 409);
  }
  return gateCase;
}

export async function commitDecision(decision: Decision, at: string, root?: string): Promise<{ chain: AuditChain; case: GateCase; entryHash: string }> {
  const workspaceId = decision.case.workspaceId;
  return enqueue(workspaceId, async () => {
    const current = await readGateAudit(workspaceId, root);
    const entry = sealEntry(current, decision.audit, at);
    const nextChain = appendEntry(current, entry);
    assertAppendOnly(current, nextChain);
    const nextCase: GateCase = { ...decision.case, auditHead: entry.hash, auditLength: nextChain.entries.length };
    await accountWrite(gateAuditKey(workspaceId), JSON.stringify(nextChain), root);
    await accountWrite(gateCaseKey(workspaceId, nextCase.planId), JSON.stringify(nextCase), root);
    return { chain: nextChain, case: nextCase, entryHash: entry.hash };
  });
}

export async function saveAgentRun(workspaceId: string, run: AgentRunRecord, root?: string): Promise<void> {
  if (containsUnsafe(JSON.stringify(run))) throw new AegisError("BAD_REQUEST", "Agent run record cannot hold a secret.", 400);
  await accountWrite(agentRunKey(workspaceId, run.id), JSON.stringify(run), root);
}

function parseChain(raw: string, workspaceId: string): AuditChain {
  try {
    const parsed = JSON.parse(raw) as AuditChain;
    if (!parsed || parsed.schema !== "binder.gate-audit.v1" || parsed.workspaceId !== workspaceId || !Array.isArray(parsed.entries)) {
      throw new Error("shape");
    }
    return parsed;
  } catch {
    throw new AegisError("AUDIT_TAMPER", "Gate audit could not be read.", 409);
  }
}

function parseCase(raw: string): GateCase {
  try {
    const parsed = JSON.parse(raw) as GateCase;
    if (!parsed || parsed.schema !== "binder.gate-case.v1") throw new Error("shape");
    return parsed;
  } catch {
    throw new AegisError("AUDIT_TAMPER", "Gate case could not be read.", 409);
  }
}

function containsUnsafe(value: string): boolean {
  return /ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+/.test(value);
}

export type { AuditBody };
