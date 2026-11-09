import type { FileComparison, StoredFile } from "@/lib/digest-model";
export type Result = FileComparison & { status: FileComparison["result"] };
export type Stored = Omit<StoredFile, "exportId"> & {
  role: "evidence" | "oscal" | "word" | "excel";
  current: boolean; exportId: string | null; keptAt: string | null;
  filename: string; title: string;
};

export type Frame22State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "evidence-mismatch"; object: Stored; result: Result; refused: number }
  | { kind: "export-mismatch"; object: Stored; result: Result; refused: number }
  | { kind: "all-match"; rows: Array<{ object: Stored; result: Result }> };

/** Objects frame 22 compares on open: the requested one, or every current file. */
export function frame22Targets(objects: Stored[], focus: string | null): Stored[] {
  if (focus) return objects.filter((item) => item.objectKey === focus);
  return objects.filter((item) => item.current);
}

export function frame22State(input: {
  objects: Stored[] | null;
  results: Record<string, Result>;
  focus: string | null;
  failed: boolean;
}): Frame22State {
  if (input.failed) return { kind: "error" };
  if (!input.objects) return { kind: "loading" };
  const targets = frame22Targets(input.objects, input.focus);
  if (targets.length === 0) return { kind: "empty" };
  if (targets.some((item) => !input.results[item.objectKey])) return { kind: "loading" };
  const mismatched = targets.filter((item) => input.results[item.objectKey]?.status === "mismatch");
  const evidence = mismatched.find((item) => item.kind === "evidence");
  const first = evidence ?? mismatched[0];
  if (first) {
    const result = input.results[first.objectKey] as Result;
    return { kind: first.kind === "evidence" ? "evidence-mismatch" : "export-mismatch", object: first, result, refused: mismatched.length };
  }
  return { kind: "all-match", rows: targets.map((object) => ({ object, result: input.results[object.objectKey] as Result })) };
}

export type Counts = { checked: number; match: number; mismatch: number; unreadable: number; unverified: number };

/** Files checked are distinct physical files that were compared or could not be read. */
export function frame25Counts(results: Result[]): Counts {
  const count = (status: Result["status"]) => results.filter((item) => item.status === status).length;
  const match = count("match");
  const mismatch = count("mismatch");
  const unreadable = count("unreadable");
  return { checked: match + mismatch, match, mismatch, unreadable, unverified: count("unverified") };
}

export type Frame25State =
  | { kind: "loading"; done: number; total: number }
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "all-match"; counts: Counts; checkedAt: string; results: Result[] }
  | { kind: "results"; counts: Counts; checkedAt: string; results: Result[] };

export function frame25State(input: {
  objects: Stored[] | null;
  check: { checkedAt: string; results: Result[] } | null;
  progress: { done: number; total: number } | null;
  failed: boolean;
}): Frame25State {
  if (input.failed) return { kind: "error" };
  if (input.progress) return { kind: "loading", ...input.progress };
  if (!input.objects) return { kind: "loading", done: 0, total: 0 };
  if (input.objects.length === 0) return { kind: "empty" };
  if (!input.check) return { kind: "loading", done: 0, total: input.objects.length };
  const counts = frame25Counts(input.check.results);
  if (counts.checked > 0 && counts.mismatch === 0 && counts.unreadable === 0 && counts.unverified === 0) return { kind: "all-match", counts, checkedAt: input.check.checkedAt, results: input.check.results };
  return { kind: "results", counts, checkedAt: input.check.checkedAt, results: input.check.results };
}

export type AuditEntry = { id: string; refusedAt: string; recordedDigest: string; recomputedDigest: string };

export type Frame23State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "missing" }
  | { kind: "evidence"; object: Stored; entries: AuditEntry[] }
  | { kind: "evidence-empty"; object: Stored }
  | { kind: "export"; object: Stored; entries: AuditEntry[]; next: Stored | null };

export function frame23State(input: { objects: Stored[] | null; focus: string | null; entries: AuditEntry[] | null; failed: boolean }): Frame23State {
  if (input.failed) return { kind: "error" };
  if (!input.objects) return { kind: "loading" };
  const object = input.objects.find((item) => item.objectKey === input.focus) ?? null;
  if (!object) return { kind: "missing" };
  if (!input.entries) return { kind: "loading" };
  const entries = [...input.entries].sort((a, b) => Date.parse(a.refusedAt) - Date.parse(b.refusedAt));
  if (object.kind === "export") {
    const next = object.current ? null : nextVersion(input.objects, object);
    return { kind: "export", object, entries, next };
  }
  return entries.length ? { kind: "evidence", object, entries } : { kind: "evidence-empty", object };
}

/** The version written when this kept file was replaced. */
export function nextVersion(objects: Stored[], kept: Stored): Stored | null {
  if (kept.replacementObjectKey) return objects.find(item => item.objectKey === kept.replacementObjectKey) ?? null;
  const group = objects.filter((item) => item.kind === "export" && item.exportId === kept.exportId && item.role === kept.role);
  return group.find((item) => item.storedAt !== null && item.storedAt === kept.keptAt) ?? null;
}

export type Frame24State =
  | { kind: "loading-object" }
  | { kind: "load-error" }
  | { kind: "missing" }
  | { kind: "disabled"; object: Stored; refused: boolean }
  | { kind: "confirm"; object: Stored; refused: boolean }
  | { kind: "building"; object: Stored; refused: boolean; step: number }
  | { kind: "done"; object: Stored; refused: boolean; next: Stored; validator: string | null }
  | { kind: "error"; object: Stored; refused: boolean }
  | { kind: "not-needed"; object: Stored };

export type RegenerateRequest = { exportId: string; newExport: true } | { render: "word" | "excel" };

/** Never substitute another object for an explicit selector. A bare entry opens
 * the latest current OSCAL export, or the evidence restriction when no export exists. */
export function regenerateTarget(objects: Stored[], selector: { objectKey: string | null; exportId?: string | null; render?: string | null }): Stored | null {
  if (selector.objectKey) return objects.find(item => item.objectKey === selector.objectKey) ?? null;
  const candidates = objects.filter(item => item.kind === "export" && item.current
    && (!selector.exportId || item.exportId === selector.exportId)
    && item.role === (selector.render ?? "oscal"));
  candidates.sort((a, b) => (b.storedAt ?? "").localeCompare(a.storedAt ?? "") || (b.exportId ?? "").localeCompare(a.exportId ?? ""));
  return candidates[0] ?? (!selector.exportId && !selector.render ? objects.find(item => item.kind === "evidence") ?? null : null);
}

/** The validator reads the latest OSCAL export, so it only runs when the regenerated file belongs to that export. */
export function validatesAfterRegenerate(objects: Stored[], object: Stored): boolean {
  if (object.kind !== "export" || !object.exportId) return false;
  const latest = objects.filter((item) => item.role === "oscal" && item.exportId).map((item) => item.exportId as string).sort().at(-1);
  return latest === object.exportId;
}

/** Regenerate follows the PR 54 route: OSCAL by export id, renders by kind. Evidence files never. */
export function regenerateRequest(object: Stored): RegenerateRequest | null {
  if (object.kind !== "export" || !object.current) return null;
  if (object.role === "word" || object.role === "excel") return { render: object.role };
  return object.exportId ? { exportId: object.exportId, newExport: true } : null;
}
