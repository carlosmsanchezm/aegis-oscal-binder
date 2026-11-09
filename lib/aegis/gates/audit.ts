import { sha256Bytes } from "../hash";
import type { AuditBody, AuditChain, AuditEntry } from "./types";

export const AUDIT_GENESIS = "0".repeat(64);
const HEX = /^[a-f0-9]{64}$/;

function canonical(entry: Omit<AuditEntry, "hash">): string {
  return [
    entry.v,
    entry.index,
    entry.at,
    entry.workspaceId,
    entry.planId,
    entry.poamId,
    entry.gateId,
    entry.action,
    entry.outcome,
    entry.reason,
    entry.actorId,
    entry.actorKind,
    entry.actorRole ?? "",
    entry.detailHash,
    entry.prevHash,
  ].join("\n");
}

export function hashAudit(entry: Omit<AuditEntry, "hash">): string {
  return sha256Bytes(canonical(entry));
}

export function emptyChain(workspaceId: string): AuditChain {
  return { schema: "binder.gate-audit.v1", workspaceId, entries: [] };
}

export function sealEntry(chain: AuditChain, body: AuditBody, at: string): AuditEntry {
  const prev = chain.entries.at(-1);
  const draft = {
    v: 1 as const,
    index: chain.entries.length,
    at,
    prevHash: prev?.hash ?? AUDIT_GENESIS,
    ...body,
  };
  return { ...draft, hash: hashAudit(draft) };
}

export function appendEntry(chain: AuditChain, entry: AuditEntry): AuditChain {
  const { hash, index, prevHash, at, ...rest } = entry;
  const body = rest as AuditBody;
  const sealed = sealEntry(chain, body, at);
  if (sealed.hash !== hash || sealed.prevHash !== prevHash || sealed.index !== index) {
    throw new Error("Audit entry does not extend the chain.");
  }
  return { ...chain, entries: [...chain.entries, sealed] };
}

export function verifyChain(chain: AuditChain): { ok: true } | { ok: false; index: number; reason: string } {
  if (chain.schema !== "binder.gate-audit.v1") return { ok: false, index: -1, reason: "schema" };
  let prev = AUDIT_GENESIS;
  for (let index = 0; index < chain.entries.length; index += 1) {
    const entry = chain.entries[index];
    if (!entry || entry.index !== index) return { ok: false, index, reason: "index" };
    if (entry.prevHash !== prev || !HEX.test(entry.hash) || !HEX.test(entry.prevHash)) return { ok: false, index, reason: "link" };
    const { hash, ...body } = entry;
    if (hashAudit(body) !== hash) return { ok: false, index, reason: "hash" };
    prev = hash;
  }
  return { ok: true };
}

export function assertAppendOnly(previous: AuditChain, next: AuditChain): void {
  if (next.workspaceId !== previous.workspaceId) throw new Error("Audit chain workspace changed.");
  if (next.entries.length !== previous.entries.length + 1) throw new Error("Audit chain is append-only.");
  for (let index = 0; index < previous.entries.length; index += 1) {
    if (JSON.stringify(previous.entries[index]) !== JSON.stringify(next.entries[index])) {
      throw new Error("An earlier audit entry changed.");
    }
  }
  const verified = verifyChain(next);
  if (!verified.ok) throw new Error(`Audit chain failed verification at ${verified.index}.`);
}
