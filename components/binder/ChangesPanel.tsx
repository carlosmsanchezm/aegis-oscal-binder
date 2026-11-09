"use client";

import type { ChangesReport, PackageState } from "@/lib/aegis/types";

type Props = {
  pkg: PackageState;
  changes: ChangesReport | null;
  busy: boolean;
  error: string | null;
  baselineEnabled: boolean;
  onReexport: () => void;
  onBaseline: () => void;
  onOpenControl: (id: string) => void;
};

function fileName(href: string): string {
  return href.split("/").at(-1) || href;
}

export function ChangesPanel({ pkg, changes, busy, error, baselineEnabled, onReexport, onBaseline, onOpenControl }: Props) {
  if (!changes) {
    return (
      <section className="screen">
        <p className="kicker">Changes</p>
        <h2>Loading changes…</h2>
      </section>
    );
  }

  const baseline = changes.baseline;
  const changedIds = new Set(changes.deltas.map((delta) => delta.controlId));

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <p className="kicker">Changes</p>
          <h2>{baseline ? `Checklist vs baseline ${baseline.id}` : "No baseline yet"}</h2>
          <p className="lede">{changes.note}</p>
          {baseline && (
            <p className="hint">
              Set {baseline.setAt.slice(0, 16).replace("T", " ")} from {baseline.exportId}. {changes.summary.total} controls in the checklist.
            </p>
          )}
        </div>
        <div className="row">
          <button
            type="button"
            className="btn ghost"
            disabled={busy || !baselineEnabled}
            aria-disabled={busy || !baselineEnabled}
            title={baselineEnabled ? "Set the checklist from the current GREEN export" : "Update baseline stays off until a GREEN export of the current IR."}
            onClick={onBaseline}
          >
            Update baseline
          </button>
          <button type="button" className="btn primary" disabled={busy || !pkg.loaded} onClick={onReexport}>
            Re export and download OSCAL
          </button>
        </div>
      </header>

      {error && <div className="banner fail">{error}</div>}

      {!baseline ? (
        <div className="block">
          <p>Update baseline is explicit. Export and render never set it. It stays off until a GREEN export of the current IR.</p>
          {changes.next.map((step) => (
            <p key={step} className="hint">{step}</p>
          ))}
        </div>
      ) : (
        <>
          <div className="steps">
            <article className="step pin">
              <span className="kicker">Baseline</span>
              <strong className="mono">{baseline.id}</strong>
              <p>From {baseline.exportId} · validator GREEN.</p>
            </article>
            <article className="step">
              <span className="kicker">Current IR</span>
              <strong>{changes.current.controlCount} controls</strong>
              <p>Completeness {changes.current.gate}.</p>
            </article>
            <article className="step">
              <span className="kicker">Checklist</span>
              <strong>{changes.summary.changed} changed · {changes.summary.unchanged} unchanged</strong>
              <p>{changes.summary.total} in scope controls vs baseline.</p>
            </article>
          </div>

          <div className="stack">
            {changes.deltas.length === 0 && <p className="hint">No named delta. Current IR matches {baseline.id}.</p>}
            {changes.deltas.map((delta, index) => (
              <article key={`${delta.controlId}-${delta.evidenceId ?? delta.field}-${index}`} className="delta">
                <p className="kicker">{index + 1} of {changes.deltas.length} · {delta.kind}</p>
                <h3>{delta.label}</h3>
                <p>
                  {delta.controlId} {delta.controlTitle}
                  {delta.evidenceId ? ` · ${delta.evidenceId} ${delta.evidenceTitle ?? ""}` : ""}
                </p>
                {delta.before && <p className="mono before">Before · {fileName(delta.before)}</p>}
                {delta.after && <p className="mono after">After · {fileName(delta.after)}</p>}
                <ul className="affects">
                  {delta.affects.map((item) => (
                    <li key={item.artifact}>
                      <span className={`pill ${item.status === "Stale" ? "warn" : item.status === "Current" ? "pass" : "miss"}`}>{item.status}</span>
                      <span>{item.artifact} · {item.detail}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn ghost" onClick={() => onOpenControl(delta.controlId)}>
                  Open {delta.controlId} on map
                </button>
              </article>
            ))}
          </div>

          <div className="block">
            {changes.next.map((step) => (
              <p key={step}>{step}</p>
            ))}
          </div>

          <div className="pills">
            {pkg.controls.map((control) => (
              <span key={control.id} className={`pill ${changedIds.has(control.id) ? "warn" : "pass"}`}>{control.id}</span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
