"use client";
import React, { useState } from "react";
import { SA1_BASELINES, SA1_RESPONSIBILITY } from "@/lib/aegis/sa1-demo";

export function Sa1Demo({ loaded, busy, onLoad, onSelect, onExport }: {
  loaded: boolean; busy: boolean; onLoad: () => void; onSelect: (id: string) => void; onExport: () => void;
}) {
  const [baselines, setBaselines] = useState(false);
  return <section className="sa1-demo" aria-label="Internal control planning">
    <div className="sa1-demo-heading"><strong>Control planning</strong><span>Internal workflow · Demo planning data</span></div>
    <div className="sa1-demo-actions">
      <button className="btn primary" disabled={busy} onClick={onLoad}>{loaded ? "Reload example" : "Load example"}</button>
      <button className="btn ghost" disabled={!loaded || busy} onClick={() => onSelect("AC-2")}>Identity & ownership</button>
      <button className="btn ghost" aria-expanded={baselines} onClick={() => setBaselines(!baselines)}>Compare baselines</button>
      <button className="btn ghost" disabled={!loaded || busy} onClick={() => onSelect("AU-2")}>Logging evidence</button>
      <button className="btn ghost" disabled={!loaded || busy} onClick={onExport}>Export & validate</button>
      <a className="btn ghost" href="/planning/pipeline">Pipeline evidence ↗</a>
    </div>
    {baselines && <div className="sa1-baselines">
      <div><strong>Selected NIST SP 800-53B baseline differences</strong><p>Comparison only. The loaded package remains the 12-control FedRAMP Rev5 Moderate subset. No baseline switch or ATO determination.</p>
      <p>AU-6(3) and AU-9(3) are outside this package. Enhancements, parameters, FedRAMP tailoring, and system-specific scope need separate review. “Not selected” is not an exemption.</p>
      <p>Source: NIST OSCAL Rev5 baseline profiles, version 5.2.0, reviewed 28 Sep 2026: {(["LOW", "MODERATE", "HIGH"] as const).map((level) => <a key={level} href={`https://github.com/usnistgov/oscal-content/blob/78650f02ad9321bb7b817846f8fbd4f2bcd620de/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_${level}-baseline_profile.json`} target="_blank" rel="noreferrer">{level.toLowerCase()} </a>)}</p></div>
      <table><caption>Selected control membership</caption><thead><tr><th>Control</th><th>Low</th><th>Moderate</th><th>High</th></tr></thead><tbody>{SA1_BASELINES.map((row) => <tr key={row.id}><th>{row.id}</th>{[row.low, row.moderate, row.high].map((selected, i) => <td key={i}>{selected ? "Selected" : "Not selected"}</td>)}</tr>)}</tbody></table>
    </div>}
    <p className="sa1-demo-note">Demo planning data only. Agency evidence and official authorization records belong in the approved environment and designated repository.</p>
  </section>;
}

export function Sa1Responsibility({ id }: { id: string }) {
  const item = SA1_RESPONSIBILITY[id];
  if (!item) return null;
  return <section className="panel-block sa1-responsibility"><span className="kicker">Responsibility · {item.kind}</span><p>{item.note}</p><details><summary>Scope & assumptions</summary><p className="hint">Illustrative allocation only. Verify provider scope before claiming inheritance. References do not establish control effectiveness, findings, or an authorization.</p></details></section>;
}
