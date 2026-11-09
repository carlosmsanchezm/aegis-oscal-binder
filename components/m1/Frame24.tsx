"use client";
import React, { useCallback, useEffect, useState } from "react";
import { CHECK, DOT, F24, KEPT, SPINNER, PERSON_NOT_RECORDED } from "@/lib/m1/copy";
import { exportFileLabel, formatPill, exportTime } from "@/lib/m1/format";
import { regenerateRequest, regenerateTarget, validatesAfterRegenerate, type Frame24State, type Result, type Stored } from "@/lib/m1/state";
import { M1RequestError, m1Json, workspaceViewHref, type Workspace } from "@/lib/m1/api";
import { M1Chrome, SideHonesty, StateCard, TitleBlock, type M1Header } from "./M1Chrome";
import { ExportRowHead } from "./Frame22";

export type Baseline = { id: string; exportId: string } | null;

export type Frame24Props = {
  workspace: Workspace;
  state: Frame24State;
  baseline: Baseline;
  onRegenerate?: () => void;
  onReload?: () => void;
};

function ExportRow({ object, children }: { object: Stored; children?: React.ReactNode }) {
  return <div className="m1-exportrow" data-testid="m1-export-row" data-object={object.objectKey}>
    <span className="m1-fmt">{formatPill(object.role)}</span>
    <span className="m1-tag-plain" title={object.objectName}>{exportFileLabel(object.objectName, object.exportId)}</span>
    <b className="m1-pin m1-nowrap">{object.exportId}</b>
    <span className="m1-code11-muted">{exportTime(object.storedAt)}</span>
    <span className="m1-person">{PERSON_NOT_RECORDED}</span>
    <span className="m1-spacer" />
    {children ? <span className="m1-pills">{children}</span> : null}
  </div>;
}

function Refused({ refused }: { refused: boolean }) {
  return refused ? <span className="m1-pill bad">{F24.readRefused}</span> : null;
}

function Cancel({ workspace }: { workspace: Workspace }) {
  return <a className="m1-btn" href={workspaceViewHref(workspace, "export")}>{F24.cancel}</a>;
}

function Confirm({ workspace, object, refused, baseline, onRegenerate }: { workspace: Workspace; object: Stored; refused: boolean; baseline: Baseline; onRegenerate?: () => void }) {
  const exportId = object.exportId ?? "";
  const title = F24.confirm(exportId);
  return <div className="m1-body">
    <div className="m1-card" data-testid="m1-frame24-main">
      <span className="m1-label">{F24.export}</span>
      <ExportRow object={object}><Refused refused={refused} /></ExportRow>
      <div className="m1-confirm">
        <h2 className="m1-confirm-title">{title[0]}<span className="m1-code">{title[1]}</span>{title[2]}</h2>
        <ol className="m1-steps" aria-label="What regenerate does">
          {F24.steps(exportId).map((step, index) => <li key={step} className="m1-step"><span className="m1-step-n">{index + 1}</span><span>{step}</span></li>)}
        </ol>
        <div className="m1-buttons">
          <button type="button" className="m1-btn primary" onClick={onRegenerate} data-testid="m1-regenerate">{F24.regenerate}</button>
          <Cancel workspace={workspace} />
        </div>
      </div>
    </div>
    <aside className="m1-side">
      <span className="m1-label">{F24.why}</span>
      <span className="m1-help">{refused ? F24.whyBody(exportId) : F24.whyMatch(exportId)}</span>
      <span className="m1-strong">{KEPT}</span>
      <span className="m1-label">{F24.notChanged}</span>
      <span className="m1-help" data-testid="m1-baseline">{baseline ? F24.baseline(baseline.id, baseline.exportId) : F24.noBaseline}</span>
      <SideHonesty />
    </aside>
  </div>;
}

function Building({ object, refused, step }: { object: Stored; refused: boolean; step: number }) {
  return <StateCard name="building">
    <ExportRow object={object}><Refused refused={refused} /></ExportRow>
    <div role="status" aria-live="polite" className="m1-col4" style={{ gap: 9 }}>
      {F24.building.map((label, index) => <div key={label} className="m1-line12">
        <span className={index <= step ? "m1-progress-on" : "m1-progress-off"} aria-hidden="true">{index < step ? CHECK : index === step ? SPINNER : DOT}</span>
        <span className={index <= step ? "m1-ink" : "m1-faint"}>{label}</span>
      </div>)}
    </div>
    <div className="m1-row"><button type="button" className="m1-btn" disabled>{F24.buildingButton}</button><span className="m1-help">{F24.buildingNote(object.exportId ?? "")}</span></div>
  </StateCard>;
}

function validatorPill(status: string | null) {
  if (!status) return <span className="m1-pill warn" data-testid="m1-validator">{F24.validatorPending}</span>;
  return <span className={`m1-pill ${status === "GREEN" ? "ok" : "bad"}`} data-testid="m1-validator">{F24.validatorResult(status)}</span>;
}

function Done({ workspace, object, refused, next, validator }: { workspace: Workspace; object: Stored; refused: boolean; next: Stored; validator: string | null }) {
  const nextLabel = exportFileLabel(next.objectName, next.exportId);
  const priorLabel = exportFileLabel(object.objectName, object.exportId);
  return <StateCard name="done">
    <ExportRow object={next}><span className="m1-pill accent">{F24.newPill}</span>{validatorPill(validator)}</ExportRow>
    <ExportRow object={object}><span className="m1-pill neutral">{F24.kept}</span><Refused refused={refused} /></ExportRow>
    <span className="m1-body-text">{validator ? F24.doneValidated(next.exportId !== object.exportId ? next.exportId! : nextLabel, next.exportId !== object.exportId ? object.exportId! : priorLabel, validator) : F24.done(nextLabel, priorLabel)}</span>
    <div className="m1-block"><a className="m1-btn" href={workspaceViewHref(workspace, "export")}>{F24.open(next.exportId ?? "")}</a></div>
  </StateCard>;
}

function Failed({ workspace, object, refused, onRegenerate }: { workspace: Workspace; object: Stored; refused: boolean; onRegenerate?: () => void }) {
  return <StateCard name="error">
    <ExportRow object={object}><Refused refused={refused} /></ExportRow>
    <div className="m1-banner bad" role="alert">{F24.failed}</div>
    <span className="m1-body-text">{F24.failedBody(object.exportId ?? "")}</span>
    <div className="m1-buttons"><button type="button" className="m1-btn primary" onClick={onRegenerate}>{F24.retry}</button><Cancel workspace={workspace} /></div>
  </StateCard>;
}

function Disabled({ object, refused }: { object: Stored; refused: boolean }) {
  return <StateCard name="disabled">
    {object.kind === "evidence"
      ? <div className="m1-evidencerow"><b className="m1-name">{object.title}</b><span className="m1-tag">{object.filename}</span><span className="m1-spacer" /><Refused refused={refused} /></div>
      : <ExportRow object={object}><span className="m1-pill neutral">{F24.kept}</span><Refused refused={refused} /></ExportRow>}
    <div className="m1-row"><button type="button" className="m1-btn" disabled data-testid="m1-regenerate">{F24.regenerate}</button><span className="m1-help">{object.kind === "evidence" ? F24.evidenceOff : F24.keptOff}</span></div>
  </StateCard>;
}

function NotNeeded({ workspace, object }: { workspace: Workspace; object: Stored }) {
  return <StateCard name="not-needed">
    <ExportRow object={object} />
    <div className="m1-banner ok" role="status">{F24.notNeeded}</div>
    <span className="m1-body-text">{F24.notNeededBody}</span>
    <div className="m1-block"><a className="m1-btn" href={workspaceViewHref(workspace, "export")}>{F24.backExports}</a></div>
  </StateCard>;
}

export function Frame24View({ workspace, state, baseline, onRegenerate, onReload }: Frame24Props) {
  let body: React.ReactNode;
  if (state.kind === "confirm") {
    body = <Confirm workspace={workspace} object={state.object} refused={state.refused} baseline={baseline} onRegenerate={onRegenerate} />;
  } else {
    let card: React.ReactNode;
    if (state.kind === "building") card = <Building object={state.object} refused={state.refused} step={state.step} />;
    else if (state.kind === "done") card = <Done workspace={workspace} object={state.object} refused={state.refused} next={state.next} validator={state.validator} />;
    else if (state.kind === "error") card = <Failed workspace={workspace} object={state.object} refused={state.refused} onRegenerate={onRegenerate} />;
    else if (state.kind === "disabled") card = <Disabled object={state.object} refused={state.refused} />;
    else if (state.kind === "not-needed") card = <NotNeeded workspace={workspace} object={state.object} />;
    else if (state.kind === "load-error") card = <StateCard name="load-error"><div className="m1-banner bad" role="alert">{F24.loadFailed}</div><span className="m1-body-text">{F24.loadFailedBody}</span><div className="m1-buttons"><button className="m1-btn primary" onClick={onReload}>{F24.retry}</button><Cancel workspace={workspace}/></div></StateCard>;
    else if (state.kind === "missing") card = <StateCard name="missing"><span className="m1-empty-title">{F24.notFound}</span><div className="m1-block"><a className="m1-btn" href={workspaceViewHref(workspace, "export")}>{F24.backExports}</a></div></StateCard>;
    else card = <StateCard name="loading-object"><div aria-busy="true" className="m1-col4" style={{ gap: 9 }}><span className="m1-skel" style={{ width: "70%" }} /><span className="m1-skel" style={{ width: "50%" }} /></div></StateCard>;
    body = <div className="m1-body"><div className="m1-left">{card}</div></div>;
  }
  return <main className="m1-main" data-testid="m1-frame24" data-state={state.kind}>
    <TitleBlock title={F24.title} chip={F24.chip} subtitle={F24.subtitle} />
    {body}
  </main>;
}

type Regenerated = { objectKey: string; objectName: string; sha256: string; exportId: string; validatorStatus?: string };

/** The successful write is authoritative even if a followup inventory read fails. */
function written(object: Stored, regenerated: Regenerated): Stored {
  return { ...object, objectKey: regenerated.objectKey, objectName: regenerated.objectName, recordedDigest: regenerated.sha256,
    exportId: regenerated.exportId, current: true, storedAt: null, keptAt: null };
}

export function RegenerateScreen({ workspace, header, buildSha, focus, exportId, render }: { workspace: Workspace; header: M1Header; buildSha: string; focus: string | null; exportId?: string | null; render?: string | null }) {
  const [state, setState] = useState<Frame24State>({ kind: "loading-object" });
  const [objects, setObjects] = useState<Stored[]>([]);
  const [baseline, setBaseline] = useState<Baseline>(null);
  const load = useCallback(async () => {
    setState({ kind: "loading-object" });
    try {
      const inventory = await m1Json<{ objects: Stored[]; baseline: Baseline }>(workspace, "/api/digest/stored");
      setObjects(inventory.objects);
      setBaseline(inventory.baseline);
      const object = regenerateTarget(inventory.objects, { objectKey: focus, exportId, render });
      if (!object) return setState({ kind: "missing" });
      const checked = await m1Json<{ result: Result }>(workspace, "/api/digest/verify", { method: "POST", body: { objectKey: object.objectKey } });
      if (object.kind === "evidence") return setState({ kind: "disabled", object, refused: checked.result.status === "mismatch" });
      if (checked.result.status !== "match" && checked.result.status !== "mismatch") return setState({ kind: "load-error" });
      const refused = checked.result.status === "mismatch";
      setState(regenerateRequest(object) ? { kind: "confirm", object, refused } : { kind: "disabled", object, refused });
    } catch {
      setState({ kind: "load-error" });
    }
  }, [workspace, focus, exportId, render]);
  useEffect(() => { void load(); }, [load]);

  async function regenerate() {
    if (state.kind !== "confirm" && state.kind !== "error") return;
    const { object, refused } = state;
    const request = regenerateRequest(object);
    if (!request) return;
    setState({ kind: "building", object, refused, step: 0 });
    let regenerated: Regenerated;
    try {
      regenerated = (await m1Json<{ regenerated: Regenerated }>(workspace, "/api/digest/regenerate", { method: "POST", body: request })).regenerated;
    } catch (error) {
      if (error instanceof M1RequestError && error.failure?.code === "REGENERATE_UNNEEDED") return setState({ kind: "not-needed", object });
      return setState({ kind: "error", object, refused });
    }
    let validator: string | null = regenerated.validatorStatus ?? null;
    if (!validator && validatesAfterRegenerate(objects, object)) {
      setState({ kind: "building", object, refused, step: 2 });
      try {
        const result = await m1Json<{ validation: { status: string; exportId: string } }>(workspace, "/api/oscal/validate", { method: "POST", body: { scenario: "current" } });
        if (result.validation.exportId === regenerated.exportId) validator = result.validation.status;
      } catch {
        validator = null;
      }
    }
    try {
      const inventory = await m1Json<{ objects: Stored[] }>(workspace, "/api/digest/stored");
      setObjects(inventory.objects);
      const next = inventory.objects.find((item) => item.objectKey === regenerated.objectKey) ?? written(object, regenerated);
      setState({ kind: "done", object, refused, next, validator });
    } catch {
      setState({ kind: "done", object, refused, next: written(object, regenerated), validator });
    }
  }

  return <M1Chrome header={header} tab="export" workspace={workspace} buildSha={buildSha} testId="m1-screen">
    <Frame24View workspace={workspace} state={state} baseline={baseline} onRegenerate={() => void regenerate()} onReload={() => void load()} />
  </M1Chrome>;
}
