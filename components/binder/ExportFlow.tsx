"use client";

import { countLabel } from "@/lib/builder/presentation";
import { useState } from "react";
import type { PackageState } from "@/lib/aegis/types";
import { m1Href } from "@/lib/m1/api";
import { Term } from "../chrome/Term";
import { sa1Api, SA1_HEADERS } from "@/lib/aegis/sa1-demo";

type CallResult = {
  ok?: boolean;
  filename?: string;
  xml?: string;
  status?: number;
  packageState?: PackageState;
  error?: { message?: string };
};
type Call = (url: string, init?: RequestInit) => Promise<CallResult>;

type Props = {
  pkg: PackageState;
  busy: boolean;
  error: string | null;
  onCall: Call;
  onOpenControl: (id: string) => void;
  sa1Demo?: boolean;
  onOpenPackage?: () => void;
  onLoadSample?: () => void;
};

export function downloadXmlFile(filename: string, xml: string): void {
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadOscalArtifact(filename: string, sa1Demo = false): Promise<void> {
  const response = await fetch(sa1Demo ? sa1Api("/api/artifacts/oscal") : "/api/artifacts/oscal", { cache: "no-store", headers: sa1Demo ? SA1_HEADERS : undefined });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: { message?: string } };
      detail = body.error?.message?.trim() ?? "";
    } catch {
      detail = "";
    }
    const sentence = detail || "Could not download the OSCAL file.";
    throw new Error(sentence.includes(`HTTP ${response.status}`) ? sentence : `${sentence} (HTTP ${response.status}).`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportFailure(message: string, status?: number): string {
  const sentence = message.trim() || "Export failed.";
  if (typeof status === "number" && status > 0 && !sentence.includes(`HTTP ${status}`)) {
    return `${sentence} (HTTP ${status}).`;
  }
  return sentence;
}

export function ExportFlow({ pkg, busy, error, onCall, onOpenControl, sa1Demo = false, onOpenPackage, onLoadSample }: Props) {
  const pipe = pkg.pipeline;
  const fail = pkg.gate.status === "FAIL";
  const empty = !pkg.loaded || pkg.gate.status === "EMPTY";
  const locked = empty || busy;
  const red = pipe.validator.status === "RED";
  const green = pipe.validator.status === "GREEN";
  const incomplete = pkg.controls.filter((control) => !control.complete);
  const first = incomplete[0];
  const parityMiss = pipe.parity && pipe.parity.matched < pipe.parity.sampled ? pipe.parity : null;
  const [exportError, setExportError] = useState<string | null>(null);
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);
  const bannerText = exportError ?? error;

  async function runCall(path: string, init?: RequestInit) {
    setExportError(null);
    return onCall(path, init);
  }

  async function exportOscal() {
    setExportError(null);
    setDownloadedFile(null);
    const body = await onCall("/api/oscal/export", { method: "POST" });
    if (!body?.ok) return;
    const filename = body.filename ?? body.packageState?.pipeline.oscal.filename ?? "";
    try {
      if (filename && typeof body.xml === "string") {
        downloadXmlFile(filename, body.xml);
      } else if (filename) {
        await downloadOscalArtifact(filename, sa1Demo);
      } else {
        throw new Error("Export did not return a file. (HTTP 200).");
      }
      setDownloadedFile(filename);
    } catch (downloadError) {
      const message = downloadError instanceof Error ? downloadError.message : "Could not download the OSCAL file.";
      setExportError(exportFailure(message));
    }
  }

  if (empty) return <section className="screen export-empty" data-testid="export-empty">
    <header className="screen-head"><div><h2>Export flow <span className="pill">No SSP package loaded</span></h2><p>Package export, validation, rendering and baseline need an SSP. Recorded observations do not contain an SSP.</p></div></header>
    <div className="export-unlock-card"><div><h3>Load a package for WIP export</h3><p>Load the demo sample SSP for the current workspace here, or upload your own OSCAL SSP on Package map. WIP export is available as soon as the package loads, even when completeness is FAIL. Recorded observations and accepted plans remain available on Release evidence.</p></div><div className="export-unlock-actions">{onLoadSample && <button type="button" className="btn primary" disabled={busy} onClick={onLoadSample}>{busy ? "Loading sample SSP…" : "Load sample SSP for this workspace"}</button>}<button type="button" className="text-btn" onClick={onOpenPackage}>Upload SSP on Package map →</button></div></div>
    <div className="export-prerequisites"><div className="label-row"><h3>Package actions and prerequisites</h3><span>Explicit actions · nothing runs automatically</span></div>
      <div className="export-prerequisite-grid">
        <article><span className="release-section-label">Package</span><h3>No SSP package</h3><p>Upload OSCAL or explicitly load a sample on Package map.</p><button className="text-btn" type="button" onClick={onOpenPackage}>Load a package on Package map →</button></article>
        <article><span className="release-section-label">Completeness</span><h3>Not checked</h3><p>Required fields and evidence for in-scope controls. An incomplete loaded package can still be exported as WIP.</p></article>
        <article><span className="release-section-label">Export OSCAL</span><h3>Not exported</h3><p>Requires a loaded package. Writes and downloads its current record.</p><button className="btn ghost" disabled>Export OSCAL</button></article>
        <article><span className="release-section-label">Validate</span><h3>Not run</h3><p>Requires a current written export. {sa1Demo ? "Structural and profile checks, not full XSD validation." : "Schema and profile checks."}</p><button className="btn ghost" disabled>Validate current</button></article>
        <article><span className="release-section-label">Render</span><h3>Word / Excel locked</h3><p>Requires completeness PASS and current validator GREEN.</p><button className="btn ghost" disabled>Render Word</button><button className="btn ghost" disabled>Render Excel</button></article>
        <article><span className="release-section-label">Baseline</span><h3>None</h3><p>Requires completeness PASS and current validator GREEN. Independent of rendering; explicit click only.</p><button className="btn ghost" disabled>Update baseline</button></article>
      </div>
    </div><p className="hint" data-testid="completeness-claim">Completeness FAIL means missing required fields or evidence, not an authorization result. Export, Validate, Render, and Baseline run on the loaded package.</p>
  </section>;

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <p className="kicker">Export</p><p className="hint" data-testid="completeness-claim">Completeness FAIL means missing required fields or evidence, not an authorization result. Export, Validate, Render, and Baseline run on the loaded package.</p>
          <h2>
            {empty
              ? "Load a package before export"
              : fail
                ? "Completeness FAIL"
                : red
                  ? "Validator RED"
                  : "Export the session package"}
          </h2>
          {empty && <p className="lede">Load an OSCAL package or the demo sample package first.</p>}
          {fail && first && (
            <p className="lede">
              {pkg.gate.incomplete} of {pkg.gate.total} in-scope controls are missing required fields. Start with {first.id}.
            </p>
          )}
          {!fail && !empty && (
            <p className="lede">
              Export, Validate, Render, and Baseline use this session package. <Term id="gate">Completeness</Term> and Validate are different checks.
            </p>
          )}
          {red && (
            <p className="lede">
              Completeness passed. This sample failed the pinned schema and profile. Word, Excel, and Update baseline stay locked until GREEN. The written package is not replaced.
            </p>
          )}
        </div>
      </header>

      {fail && (
        <div className="path-back" role="navigation" aria-label="Path back to incompletes">
          <span className="path-label">Path back</span>
          <span className="path-detail">
            {countLabel(pkg.gate.incomplete,"incomplete control")} · missing required fields · start with <span className="mono">{first?.id}</span>
          </span>
          {incomplete.map((control) => (
            <button key={control.id} type="button" className="btn ghost" onClick={() => onOpenControl(control.id)}>
              Open {control.id} on map
            </button>
          ))}
        </div>
      )}

      {fail && (
        <div className="banner warn" role="status">
          <strong>Completeness FAIL.</strong> {pkg.gate.incomplete} of {pkg.gate.total} in-scope controls are missing required fields
          (implementation, responsible role, or evidence). This is not an authorization result. WIP export can still be downloaded.{" "}
          <Term id="wip">What WIP means</Term>
        </div>
      )}
      {red && <div className="banner fail">Validator RED · the written package was rejected.</div>}
      {bannerText && <div className="banner fail">{bannerText}</div>}

      <div className="feature-grid">
        <article className="feature-card primary-feat">
          <h3>Export OSCAL</h3>
          <p className="hint">One action writes the session package and downloads that file.</p>
          <p className="artifact-name">
            {empty ? "—" : pipe.oscal.filename}
            {downloadedFile && downloadedFile === pipe.oscal.filename ? " · Downloaded" : ""}
          </p>
          <p className="hint">
            {pipe.oscal.status === "written" ? "Written" : pipe.oscal.status === "ready" ? "Ready" : "Waiting for a package"}
            {fail ? " · completeness FAIL · WIP " : ""}
            {fail ? <Term id="wip">What WIP means</Term> : null}
            {pipe.oscal.stale ? " · stale · export again" : ""}
          </p>
          <button type="button" className="btn primary" disabled={locked} onClick={() => void exportOscal()}>
            Export OSCAL
          </button>
          <div className="row" data-testid="stored-file-entry-points">
            <a className="btn ghost" href={m1Href(sa1Demo ? "planning" : "classic", "/stored/evidence")}>Stored exports</a>
            <a className="btn ghost" href={m1Href(sa1Demo ? "planning" : "classic", "/stored/audit")}>Open audit trail</a>
            <a className="btn ghost" href={m1Href(sa1Demo ? "planning" : "classic", "/stored/verify")}>Verify stored files</a>
          </div>
        </article>

        <article className="feature-card">
          <h3>Validate</h3>
          <p className="hint">{sa1Demo ? "Structural and profile checks—not full XSD validation, an assessment, or an ATO." : "Schema and profile checks on the written OSCAL. Separate from completeness."}</p>
          <p className="hint">
            {pipe.validator.status === "NOT_RUN" ? "Not run" : pipe.validator.status}
            {pipe.validator.status !== "NOT_RUN" ? ` · ${countLabel(pipe.validator.errorCount,"error")}` : ""}
          </p>
          <div className="row">
            <button
              type="button"
              className="btn ghost"
              disabled={locked || pipe.oscal.status !== "written" || pipe.oscal.stale}
              onClick={() => void runCall("/api/oscal/validate", { method: "POST", body: JSON.stringify({ scenario: "current" }) })}
            >
              Validate current
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={locked || pipe.oscal.status !== "written" || pipe.oscal.stale}
              onClick={() => void runCall("/api/oscal/validate", { method: "POST", body: JSON.stringify({ scenario: "red" }) })}
            >
              Validator RED sample
            </button>
          </div>
        </article>

        <article className="feature-card">
          <h3>Render Word / Excel</h3>
          {sa1Demo && <p className="hint">Office outputs are working stubs, not finished agency deliverables.</p>}
          <p className="hint">Parity is checked during rendering; any field mismatches appear below.</p>
          <p className="hint">{pipe.word.lockedReason && pipe.word.lockedReason === pipe.excel.lockedReason ? pipe.word.lockedReason : `${renderLine("Word", pipe.word)} · ${renderLine("Excel", pipe.excel)}`}</p>
          <div className="row">
            <button
              type="button"
              className="btn ghost"
              disabled={locked || pipe.word.status === "locked"}
              onClick={() => void runCall("/api/render/word", { method: "POST" })}
            >
              Render Word
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={locked || pipe.excel.status === "locked"}
              onClick={() => void runCall("/api/render/excel", { method: "POST" })}
            >
              Render Excel
            </button>
          </div>
          <div className="row">
            {pipe.word.status === "rendered" && <a className="btn ghost" href={sa1Demo ? sa1Api("/api/artifacts/word") : "/api/artifacts/word"}>Download Word</a>}
            {pipe.excel.status === "rendered" && <a className="btn ghost" href={sa1Demo ? sa1Api("/api/artifacts/excel") : "/api/artifacts/excel"}>Download Excel</a>}
          </div>
        </article>

        <article className="feature-card">
          <h3>Baseline</h3>
          <p className="hint">Explicit click only. Re-export and render do not advance baseline.</p>
          <p className="artifact-name">{pipe.baseline.id ?? "None"}</p>
          <p className="hint">{pipe.baseline.reason}</p>
          <button
            type="button"
            className="btn ghost"
            disabled={locked || !pipe.baseline.enabled}
            aria-disabled={locked || !pipe.baseline.enabled}
            title={pipe.baseline.reason}
            onClick={() => void runCall("/api/baseline", { method: "POST" })}
          >
            Update baseline
          </button>
        </article>
      </div>

      <p className="hint">
        Completeness is <Term id="ir">package record</Term> field completeness for in-scope controls. {sa1Demo ? "Validate checks this harness's structural/profile rules on serialized OSCAL." : "Validate is schema and profile on serialized OSCAL."} Neither is an authorization result.
      </p>

      {red && (
        <div className="block">
          <h3>Validator errors · {pipe.validator.errorCount}</h3>
          <p className="hint">Invalid OSCAL is never marked green. The RED sample does not overwrite the written file.</p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Check</th>
                <th>Error</th>
                <th>OSCAL path</th>
                <th><Term id="ir">Source in package record</Term></th>
                <th>Next</th>
              </tr>
            </thead>
            <tbody>
              {pipe.validator.errors.map((item) => {
                const controlId = item.sourceInIr.match(/\b[A-Z]{2}-\d+\b/)?.[0];
                return (
                  <tr key={item.id}>
                    <td className="mono">{item.id}</td>
                    <td>{item.check}</td>
                    <td>{item.message}</td>
                    <td className="mono">{item.oscalPath}</td>
                    <td>{item.sourceInIr}</td>
                    <td>
                      {controlId ? (
                        <button type="button" className="text-btn" onClick={() => onOpenControl(controlId)}>
                          Open {controlId} on map
                        </button>
                      ) : (
                        <span className="hint">Fix in serializer</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {parityMiss && (
        <div className="block">
          <h3>Parity mismatch · {parityMiss.matched} of {parityMiss.sampled} sampled fields match</h3>
          <table>
            <thead>
              <tr>
                <th><Term id="ir">IR field</Term></th>
                <th>OSCAL</th>
                <th>Word</th>
                <th>Excel</th>
              </tr>
            </thead>
            <tbody>
              {parityMiss.samples.filter((sample) => !sample.oscal.match || !sample.word.match || !sample.excel.match).map((sample) => (
                <tr key={sample.field}>
                  <td>{sample.field}</td>
                  <td>{sample.oscal.match ? "✓" : "✕"} {sample.oscal.label}</td>
                  <td>{sample.word.match ? "✓" : "✕"} {sample.word.label}</td>
                  <td className="mono">{sample.excel.match ? "✓" : "✕"} {sample.excel.cell}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pipe.parity && !parityMiss && <p className="hint">Parity check passed.</p>}
    </section>
  );
}

function renderLine(
  kind: "Word" | "Excel",
  card: { status: "locked" | "ready" | "rendered"; stale: boolean; lockedReason: string | null },
): string {
  if (card.status === "rendered" && !card.stale) return `${kind} rendered`;
  if (card.stale) return `${kind} stale · render again`;
  if (card.lockedReason) return card.lockedReason;
  return `${kind} ready`;
}
