import { randomUUID } from "node:crypto";
import { AegisError } from "./errors";
import { evidenceFileStatus } from "./evidence";
import { addEvidence } from "./operations";
import { rev5StatementItems } from "./map-graph";
import type { ControlRecord, Ctx, EvidenceInput, ItemStatementRecord, PersistedState } from "./types";

export type StatementPartView = {
  statementId: string;
  label: string | null;
  catalogProse: string;
  implementation: string;
  evidence: Array<{ id: string; title: string; type: string; href: string; uuid: string; sha256?: string; valid: boolean }>;
  status: "complete" | "blank" | "partial";
  reasons: Array<"missing implementation" | "missing evidence">;
};

function findControl(state: PersistedState, controlId: string): ControlRecord {
  const control = state.controls.find((item) => item.id.toLowerCase() === controlId.trim().toLowerCase());
  if (!control) throw new AegisError("CONTROL_NOT_FOUND", `Unknown control ${controlId}`, 404);
  return control;
}

export function validPartIds(root: string, controlId: string): string[] {
  return rev5StatementItems(root, controlId).map((item) => item.id);
}

export function requirePartId(root: string, controlId: string, statementId: string): string {
  const ids = validPartIds(root, controlId);
  const found = ids.find((id) => id.toLowerCase() === statementId.trim().toLowerCase());
  if (!found) {
    const listed = ids.length > 0 ? ids.join(", ") : "none";
    throw new AegisError(
      "BAD_STATEMENT_ID",
      `Bad statement id ${statementId.trim() || "(empty)"}. Valid part ids: ${listed}.`,
      400,
      { validPartIds: ids, controlId },
    );
  }
  return found;
}

function partStatus(description: string, validEvidence: number): Pick<StatementPartView, "status" | "reasons"> {
  const hasText = description.trim().length > 0;
  const reasons: StatementPartView["reasons"] = [];
  if (!hasText) reasons.push("missing implementation");
  if (validEvidence < 1) reasons.push("missing evidence");
  if (reasons.length === 0) return { status: "complete", reasons };
  if (!hasText && validEvidence < 1) return { status: "blank", reasons };
  return { status: "partial", reasons };
}

export function readStatementParts(state: PersistedState, controlId: string, ctx: Ctx): { controlId: string; parts: StatementPartView[]; validPartIds: string[] } {
  if (!state.loaded) throw new AegisError("NO_FIXTURE", "Load an OSCAL package or the demo sample package first.", 400);
  const control = findControl(state, controlId);
  const catalog = rev5StatementItems(ctx.root, control.id);
  const stored = new Map((control.itemStatements ?? []).map((item) => [item.statementId.toLowerCase(), item]));
  const parts = catalog.map((item) => {
    const record = stored.get(item.id.toLowerCase());
    const linked = (record?.evidenceUuids ?? [])
      .map((uuid) => control.evidence.find((evidence) => evidence.uuid === uuid))
      .filter((evidence): evidence is ControlRecord["evidence"][number] => Boolean(evidence));
    const views = linked.map((evidence) => {
      const status = evidenceFileStatus(evidence, ctx);
      return {
        id: evidence.id,
        title: evidence.title,
        type: evidence.type,
        href: evidence.href,
        uuid: evidence.uuid,
        ...(evidence.sha256 ? { sha256: evidence.sha256 } : {}),
        valid: status.valid,
      };
    });
    const status = partStatus(record?.description ?? "", views.filter((item) => item.valid).length);
    return {
      statementId: item.id,
      label: item.label,
      catalogProse: item.prose,
      implementation: record?.description ?? "",
      evidence: views,
      ...status,
    };
  });
  return { controlId: control.id, parts, validPartIds: catalog.map((item) => item.id) };
}

export function readStatementPart(state: PersistedState, controlId: string, statementId: string, ctx: Ctx): StatementPartView & { controlId: string } {
  requirePartId(ctx.root, controlId, statementId);
  const all = readStatementParts(state, controlId, ctx);
  const part = all.parts.find((item) => item.statementId.toLowerCase() === statementId.trim().toLowerCase());
  if (!part) {
    throw new AegisError("BAD_STATEMENT_ID", `Bad statement id ${statementId}.`, 400, { validPartIds: all.validPartIds, controlId: all.controlId });
  }
  return { controlId: all.controlId, ...part };
}

export type StatementPartInput = {
  implementation?: string;
  evidence?: EvidenceInput | null;
};

/**
 * Writes one statement part through the control evidence path.
 * The control implementation and role are left as they are.
 */
export function saveStatementPart(
  state: PersistedState,
  controlId: string,
  statementId: string,
  input: StatementPartInput,
  ctx: Ctx,
): PersistedState {
  if (!state.loaded) throw new AegisError("NO_FIXTURE", "Load an OSCAL package or the demo sample package first.", 400);
  const control = findControl(state, controlId);
  const partId = requirePartId(ctx.root, control.id, statementId);
  let next = state;
  let linkedUuid = "";
  if (input.evidence && (input.evidence.title.trim() || input.evidence.type.trim() || input.evidence.href.trim())) {
    next = addEvidence(next, control.id, input.evidence, ctx);
    linkedUuid = next.controls.find((item) => item.id === control.id)?.evidence.at(-1)?.uuid ?? "";
  }
  const draft = structuredClone(next);
  const target = findControl(draft, control.id);
  const items = target.itemStatements ?? [];
  let record = items.find((item) => item.statementId.toLowerCase() === partId.toLowerCase());
  if (!record) {
    record = {
      statementId: partId,
      uuid: randomUUID(),
      description: "",
      componentUuid: "",
      byComponentUuid: randomUUID(),
      evidenceUuids: [],
    } satisfies ItemStatementRecord;
    items.push(record);
  }
  if (input.implementation !== undefined) record.description = input.implementation.trim();
  if (linkedUuid && !record.evidenceUuids.includes(linkedUuid)) record.evidenceUuids.push(linkedUuid);
  target.itemStatements = items;
  return draft;
}
