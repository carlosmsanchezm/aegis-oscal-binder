"use client";
import { footprintRows } from "@/lib/aegis/footprint-rows";
import { countLabel } from "@/lib/builder/presentation";

import React, { useEffect, useRef, useState } from "react";
import { coverageCounts, coverageMatches, coverageSource, type CoverageFamily, type CoverageFilter } from "@/lib/aegis/baseline-coverage";
import type { ControlRollupRow } from "@/lib/aegis/control-rollup";
import { artifactFilename, gitlabArtifactUrl, type PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { MODERATE_PROFILE_VERSION } from "@/lib/aegis/moderate-baseline";

export type CoverageNavigation = { expanded: boolean; family: string | null; filter: CoverageFilter };
export const DEFAULT_COVERAGE_NAVIGATION: CoverageNavigation = { expanded: false, family: null, filter: "all" };
const FILTERS: { id: CoverageFilter; label: string }[] = [{ id: "all", label: "All" }, { id: "linked", label: "Evidence linked" }, { id: "blank", label: "No evidence linked" }, { id: "review", label: "Needs review" }];
function status(row: ControlRollupRow) { return !row.result ? "Blank" : row.result.checks.length ? "Measured retest" : row.result.finding ? "Needs review" : "Evidence linked"; }

export function BaselineFootprint({ families, selected, onSelect, onExpand, accumulated = false, suggested = new Set<string>() }: { families: CoverageFamily[]; selected: string | null; onSelect: (id: string) => void; onExpand: () => void; accumulated?: boolean; suggested?: ReadonlySet<string> }) {
  const rows = footprintRows(families,suggested);
  return <section className="release-card r3-footprint" aria-label={accumulated ? "Workspace baseline footprint" : "Selected release baseline footprint"}>
    <div className="release-section-title"><h2>{accumulated ? "Workspace footprint" : "Baseline footprint"} <small>· Rev5 Moderate</small></h2><button type="button" className="coverage-text-action" onClick={onExpand}>Baseline coverage →</button></div>
    <div className="r3fp-table"><div className="r3fp-row r3fp-head"><span>Family</span><span/><span className="r3fp-n r3fp-e"><i className="r3fp-key" style={{background:"#16a36b"}}/>Evidence</span><span className="r3fp-n r3fp-s"><i className="r3fp-key" style={{background:"#ffe3a1",border:"1.5px dashed #d99a00"}}/>Suggested</span><span className="r3fp-n">Total</span></div>{rows.map(row=>{const family=row.kind==="family",on=family&&selected===row.id,Tag=family?"button":"div";return <Tag key={row.id} type={family?"button":undefined} data-family={family?row.id:undefined} aria-pressed={family?on:undefined} aria-label={`${row.id}${row.title?" · "+row.title:""} · ${row.evidence} with evidence · ${row.suggested} suggested · ${row.total} total`} title={row.title||undefined} onClick={family?()=>onSelect(row.id):undefined} className={`r3fp-row${row.kind==="all"?" r3fp-all":""}${row.kind==="sub"?" r3fp-sub":""}${on?" is-on":""}`}><span className="r3fp-name"><strong>{row.id}</strong>{row.title&&<span>{row.title}</span>}</span><span className="r3fp-bar" aria-hidden="true"><i style={{width:`${row.total?row.evidence/row.total*100:0}%`,background:"#16a36b"}}/><i style={{width:`${row.total?row.suggested/row.total*100:0}%`,background:"#ffe3a1",boxShadow:"inset 0 0 0 1px #d99a00"}}/></span><span className={`r3fp-n r3fp-e${row.evidence?"":" is-zero"}`}>{row.evidence||"–"}</span><span className={`r3fp-n r3fp-s${row.suggested?"":" is-zero"}`}>{row.suggested?"+"+row.suggested:"–"}</span><span className="r3fp-n">{row.total}</span></Tag>;})}</div>
  </section>;
}

type InspectorProps = { family: CoverageFamily; history: PipelineEvidence[]; accumulated: boolean; filter?: CoverageFilter; onClose: () => void; onExpand?: () => void; onOpenControl: (id: string, focus: boolean, artifact?: string, source?: PipelineEvidence) => void; onReview: (row?: ControlRollupRow) => void; };
export function CoverageFamilyInspector({ family, history, accumulated, filter = "all", onClose, onExpand, onOpenControl, onReview }: InspectorProps) {
  const counts = coverageCounts(family.controls);
  const [highlight, setHighlight] = useState<string | null>(null);
  const headingRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setHighlight(null); headingRef.current?.focus(); }, [family.id]);
  function open(row: ControlRollupRow, focus: boolean, artifact?: string) {
    const source = coverageSource(row, history);
    onOpenControl(row.id, focus, artifact, source);
  }
  function entry(row: ControlRollupRow) {
    const source = coverageSource(row, history);
    return <div key={row.id} className={`coverage-control-row${highlight === row.id ? " is-highlighted" : ""}${coverageMatches(row, filter) ? "" : " is-filtered"}`} data-control={row.id} data-result={row.result ? "recorded" : "blank"} onMouseEnter={() => setHighlight(row.id)} onMouseLeave={() => setHighlight(null)}>
      <div className="coverage-control-heading"><button type="button" className="coverage-control-action" aria-label={`${row.id} · ${row.title} · Level 2`} onClick={() => open(row, true)}><i className={`coverage-dot${row.enhancement ? " enhancement" : ""}${row.result ? " linked" : ""}${row.result?.finding ? " review" : ""}`} aria-hidden="true" /><strong>{row.id}</strong><span>{row.title}</span></button><small className={row.result?.finding ? "review-ink" : ""}>{status(row)}</small></div>
      {row.result && <div className="coverage-control-evidence"><span>Source #{row.result.releaseId} · {row.result.createdAt.slice(0,10)} · control-level</span><div>{row.result.evidence.map(name => {
        const href = source && gitlabArtifactUrl(source, name);
        return href ? <span key={name} className="coverage-artifact"><a href={href} target="_blank" rel="noopener noreferrer">{artifactFilename(name)} ↗</a><button type="button" aria-label={`Trace ${artifactFilename(name)} for ${row.id} on map`} onClick={() => open(row, false, name)}>→</button></span> : null;
      })}</div><div className="coverage-control-links"><button type="button" onClick={() => open(row, false, row.result?.evidence[0])} aria-label={`Trace ${row.id} evidence on map`}>Show on map →</button><button type="button" onClick={() => open(row, true)} aria-label={`${row.id} in Level 2`}>Open in Level 2 →</button>{row.result.finding && <button type="button" onClick={() => onReview(row)}>Open review item →</button>}</div>
      {row.result.checks.length > 0 && <details><summary>{row.result.checks.length} measured tests · separate from pipeline checks</summary>{row.result.checks.map(check => <p key={check.description}>{check.description} · {check.verdict ?? check.result} · {check.date}</p>)}</details>}</div>}
    </div>;
  }
  const bases = family.controls.filter(r => !r.enhancement);
  const firstLinked = family.controls.find(r => r.result);
  return <aside className="release-card coverage-family-inspector" aria-label={`${family.id} family inspector`}>
    <div className="release-section-title"><h2>{family.id} · {family.title}</h2><button ref={headingRef} type="button" className="release-close" onClick={onClose} aria-label="Close family inspector">×</button></div>
    <div className="coverage-inspector-counts"><b>{counts.linked} linked</b><span>{counts.blank} blank</span>{counts.review > 0 && <span className="review-ink">{counts.review} need review</span>}</div>
    <p className="coverage-caption">{bases.length} base controls · {family.controls.length - bases.length} enhancements · {accumulated ? "across stored releases" : "selected release only"}</p>
    <div className="coverage-control-list">{accumulated ? bases.map(base => {
      const enhancements = family.controls.filter(r => r.enhancement && r.id.split(/[.(]/)[0] === base.id);
      return <div key={base.id}>{entry(base)}{enhancements.length > 0 && <details className="coverage-enhancements"><summary>{enhancements.length} required enhancement{enhancements.length > 1 ? "s" : ""}</summary>{enhancements.map(entry)}</details>}</div>;
    }) : <><h3>Linked by this release</h3>{family.controls.filter(r => r.result).map(entry)}{counts.linked === 0 && <p className="coverage-caption">No evidence linked by this release.</p>}<h3>No evidence linked · {counts.blank}</h3><div className="coverage-blank-chips">{bases.filter(r => !r.result).map(r => <button type="button" key={r.id} title={r.title} onClick={() => open(r, true)}>{r.id}</button>)}</div><details className="coverage-enhancements"><summary>{family.controls.filter(r => r.enhancement).length} required enhancements</summary>{family.controls.filter(r => r.enhancement).map(entry)}</details></> }</div>
    <p className="coverage-caption">Blank ≠ noncompliant · Linked ≠ satisfied</p>
    <div className="coverage-inspector-footer">{onExpand && <button type="button" className="btn ghost" onClick={onExpand}>Baseline coverage · {family.id} →</button>}{firstLinked && <button type="button" className="btn primary" onClick={() => open(firstLinked, true)}>Open {firstLinked.id} in Level 2</button>}</div>
  </aside>;
}

export function BaselineWorkspace({ families, history, record, navigation, onNavigation, onOpenControl, onReview }: { families: CoverageFamily[]; history: PipelineEvidence[]; record: PipelineEvidence; navigation: CoverageNavigation; onNavigation: (next: CoverageNavigation) => void; onOpenControl: InspectorProps["onOpenControl"]; onReview: InspectorProps["onReview"] }) {
  const rows = families.flatMap(f => f.controls);
  const counts = coverageCounts(rows);
  const family = families.find(f => f.id === navigation.family);
  const [hovered, setHovered] = useState<string | null>(null);
  return <section className="baseline-workspace" aria-label="Accumulated baseline coverage" data-testid="baseline-workspace">
    <div className="coverage-toolbar"><h1>Baseline coverage</h1><span className="coverage-baseline-label" title={`Pinned profile: ${MODERATE_PROFILE_VERSION}`}>FedRAMP Rev5 · Moderate</span><span>{families.length} families · {counts.all} entries <small>({rows.filter(r => !r.enhancement).length} base + {rows.filter(r => r.enhancement).length} enh)</small></span><button type="button" className="coverage-text-action" onClick={() => onNavigation({ ...navigation, expanded: false })}>← Release overview</button></div>
    <div className="coverage-summary"><div className="coverage-progress" aria-hidden="true"><span style={{width:`${counts.linked/counts.all*100}%`}} /></div><span data-testid="coverage-totals">{counts.linked} evidence linked · {counts.blank} no evidence linked</span><div className="coverage-filters" aria-label="Baseline coverage filters">{FILTERS.map(f => <button key={f.id} type="button" aria-pressed={navigation.filter === f.id} onClick={() => onNavigation({...navigation,filter:f.id})}>{f.label} <small>{counts[f.id]}</small></button>)}</div></div>
    <p className="coverage-caption">Across {history.length} stored releases in this project · {navigation.filter === "all" ? "All entries shown" : `${rows.filter(r => coverageMatches(r,navigation.filter)).length} of ${counts.all} emphasized · totals unchanged`}</p>
    <div className="coverage-workspace-grid"><div className="coverage-families">{families.map(f => {
      const c = coverageCounts(f.controls);
      return <button type="button" className={`coverage-family-card${hovered === f.id ? " is-hovered" : ""}`} key={f.id} aria-label={`${f.id} · ${f.title} · ${c.linked} linked · ${c.blank} blank`} aria-pressed={navigation.family === f.id} data-family={f.id} onMouseEnter={() => setHovered(f.id)} onMouseLeave={() => setHovered(null)} onClick={() => onNavigation({...navigation,family:navigation.family === f.id ? null : f.id})}>
        <div><strong>{f.id}</strong>{c.review > 0 && <small className="review-ink">◐ {c.review} review</small>}</div><span className="coverage-family-title" title={f.title}>{f.title}</span><div className="coverage-family-count"><b>{c.linked}</b> linked <span>{c.blank} blank</span></div>
        {[false,true].map(enhancement => <div key={String(enhancement)} className="coverage-dots">{f.controls.filter(r => r.enhancement === enhancement).map(r => <i key={r.id} title={`${r.id} · ${r.title} · ${status(r)}`} data-control={r.id} data-result={r.result ? "recorded" : "blank"} className={`coverage-dot${enhancement ? " enhancement" : ""}${r.result ? " linked" : ""}${r.result?.finding ? " review" : ""}${coverageMatches(r,navigation.filter) ? "" : " is-filtered"}`} />)}</div>)}
        <small className="coverage-family-scope">{f.controls.filter(r => !r.enhancement).length} base · {f.controls.filter(r => r.enhancement).length} enh</small>
      </button>;
    })}</div>{family ? <CoverageFamilyInspector key={family.id} family={family} history={history} accumulated filter={navigation.filter} onClose={() => onNavigation({...navigation,family:null})} onOpenControl={onOpenControl} onReview={onReview} /> : <aside className="release-card coverage-release-panel" aria-label="Release panel"><div className="release-section-title"><h2>Release panel</h2><span>#{record.pipelineId}</span></div><p>Policy {record.policyVerdict.toUpperCase()} · {countLabel(record.findingCount,"finding")} retained</p><h3>Pipeline checks · {record.checks.length}</h3>{record.checks.map(check => <div key={check.id}><strong>{check.id}</strong><b className={check.status === "pass" ? "good" : "bad"}>{check.status.toUpperCase()}</b></div>)}<p className="coverage-caption">Latest evidence per control; older evidence remains where no newer supporting result exists.</p><button type="button" className="coverage-text-action" onClick={() => onReview()}>Open review items →</button></aside>}</div>
    <p className="coverage-caption coverage-legend"><i className="coverage-dot linked" /> Evidence linked <i className="coverage-dot" /> Blank <i className="coverage-dot linked review" /> Needs review <i className="coverage-dot enhancement" /> Enhancement · coverage only, not authorization</p>
  </section>;
}
