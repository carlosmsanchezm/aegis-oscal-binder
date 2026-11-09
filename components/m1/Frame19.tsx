"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { DOT, ELLIPSIS, F19, HONESTY, OUT, PLANNED_SAMPLE } from "@/lib/m1/copy";
import { clockTime, expiredTime, fullTime, receiptDigest, releaseLabel, revisionLabel, storedTime } from "@/lib/m1/format";
import { excerptTokens, measuredAllowed, type ExcerptToken } from "@/lib/m1/json-excerpt";
import { checkState, freshnessLabel, type CheckState, type EvidenceBundle, type EvidenceEvent } from "@/lib/builder/evidence";
import type { Workspace } from "@/lib/m1/api";
import { Chip, M1Chrome, type M1Header } from "./M1Chrome";

type Check = EvidenceEvent["checks"][number];
type Artifact = EvidenceEvent["artifacts"][number];

export type Frame19Load =
  | { kind: "loading" }
  | { kind: "error"; message: string; notFound: boolean }
  | { kind: "ready"; bundle: EvidenceBundle };

export type Frame19Popover = "current" | "expired" | "verified" | null;

export type ArtifactContent =
  | { kind: "json"; value: unknown; full: string }
  | { kind: "text"; text: string }
  | { kind: "binary" };

function decode(artifact: Artifact): string {
  const bytes = Uint8Array.from(atob(artifact.contentBase64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** JSON is parsed for the excerpt; other text stays escaped original text. */
export function artifactContent(artifact: Artifact): ArtifactContent {
  const textual = artifact.mediaType.startsWith("text/") || /\/(?:json|xml|[^/]+\+json|[^/]+\+xml)$/.test(artifact.mediaType);
  if (!textual) return { kind: "binary" };
  const text = decode(artifact);
  if (artifact.mediaType.includes("json")) {
    try {
      const value = JSON.parse(text) as unknown;
      return { kind: "json", value, full: JSON.stringify(value, null, 2) };
    } catch {
      return { kind: "text", text };
    }
  }
  return { kind: "text", text };
}

export function initialArtifact(event: EvidenceEvent, artifactName?: string, checkId?: string): string | undefined {
  if (artifactName) return artifactName;
  const check = event.checks.find((c) => !checkId || c.id === checkId);
  return event.artifacts.find((a) => check?.artifacts.includes(a.name))?.name ?? event.artifacts[0]?.name;
}

/** The earliest deadline among the shown checks that passed before the bundle arrived. */
export function receivedAfterExpiry(bundle: EvidenceBundle, checks: Check[]): string | null {
  const received = Date.parse(bundle.receivedAt);
  const expired = checks.map((c) => c.validUntil).filter((at) => Date.parse(at) < received).sort((a, b) => Date.parse(a) - Date.parse(b));
  return expired[0] ?? null;
}

function stateClass(state: CheckState): string {
  return state === "stale" || state === "future" || state === "outdated" ? "m1-f19-expired" : "m1-f19-fresh";
}

function verdictClass(verdict: Check["verdict"]): string {
  return verdict === "pass" ? "m1-f19-pass" : verdict === "fail" ? "m1-f19-fail" : "m1-f19-expired";
}

export type Frame19Props = {
  receipt: string;
  download: string;
  load: Frame19Load;
  now: number;
  checkId?: string;
  selected: string | undefined;
  expanded: ReadonlySet<string>;
  limitationsOpen: boolean;
  popover: Frame19Popover;
  copied: string | null;
  source?: React.ReactNode;
  onSelect?: (name: string | undefined) => void;
  onExpand?: (path: string) => void;
  onToggleLimitations?: () => void;
  onPopover?: (popover: Frame19Popover) => void;
  onCopy?: (value: string, label: string) => void;
};

function StateCard19({ name, children }: { name: string; children: React.ReactNode }) {
  return <section className="m1-state19" data-testid="m1-state-card" data-state={name}>
    <div className="m1-state19-col">
      {children}
      <span className="m1-state19-honesty" data-testid="m1-honesty">{HONESTY}</span>
    </div>
  </section>;
}

function CopyButton({ value, label, copied, onCopy }: { value: string; label: string; copied: string | null; onCopy?: (value: string, label: string) => void }) {
  return <button type="button" className="m1-f19-link" onClick={() => onCopy?.(value, label)}>{copied === label ? F19.copied : copied === `${label}:failed` ? F19.copyFailed : F19.copy}</button>;
}

function ObservationHead({ id, release }: { id: string; release: React.ReactNode }) {
  return <div className="m1-f19-head">
    <h2 className="m1-f19-h">{F19.observation} <span className="m1-f19-h-mono">#{id}</span></h2>
    <span className="m1-f19-meta">{release}</span>
  </div>;
}

function ReleaseMeta({ receipt }: { receipt: string }) {
  return <span>{F19.release} <span className="m1-code11">{releaseLabel(receipt)}</span></span>;
}

function ExcerptBody({ tokens, onExpand }: { tokens: ExcerptToken[]; onExpand?: (path: string) => void }) {
  return <pre className="m1-code-body" tabIndex={0}>{tokens.map((token, index) => {
    if (token.kind === "key") return <span key={index} className="m1-tok-key">{token.text}</span>;
    if (token.kind === "string") return <span key={index} className="m1-tok-str">{token.text}</span>;
    if (token.kind === "literal") return <span key={index} className="m1-tok-lit">{token.text}</span>;
    if (token.kind === "fold") return <button key={index} type="button" className="m1-tok-fold" aria-label={F19.expandLabel(token.count)} onClick={() => onExpand?.(token.path)}>{token.text}</button>;
    return <React.Fragment key={index}>{token.text}</React.Fragment>;
  })}</pre>;
}

function ArtifactDetail({ artifact, controlFor, download, expanded, copied, source, onExpand, onCopy }: {
  artifact: Artifact;
  controlFor: string | null;
  download: string;
  expanded: ReadonlySet<string>;
  copied: string | null;
  source?: React.ReactNode;
  onExpand?: (path: string) => void;
  onCopy?: (value: string, label: string) => void;
}) {
  const content = useMemo(() => artifactContent(artifact), [artifact]);
  const tokens = useMemo(() => content.kind === "json" ? excerptTokens(content.value, expanded) : [], [content, expanded]);
  const folded = tokens.some((token) => token.kind === "fold");
  const allowed = content.kind === "json" ? measuredAllowed(content.value) : null;
  const measured = allowed === null || !controlFor ? null : F19.measured("status.allowed", String(allowed), controlFor);
  return <article className="m1-f19-artifact fill" data-testid="retained-artifact" aria-label={F19.selectedArtifact}>
    <div className="m1-f19-artifact-head">
      <div className="m1-row">
        <h3 className="m1-f19-artifact-name">{artifact.name}</h3>
        <span className="m1-spacer" />
        <a className="m1-btn30" href={`${download}&${new URLSearchParams({ artifact: artifact.name })}`} aria-label={F19.downloadArtifactLabel}>{F19.downloadArtifact}</a>
      </div>
      {source && <span className="m1-f19-digest">{source}</span>}
      <span className="m1-f19-digest">{artifact.mediaType} {DOT} SHA-256 <span className="m1-f19-digest-code">{artifact.sha256}</span></span>
    </div>
    {content.kind === "binary"
      ? <p className="m1-help145">{F19.binary}</p>
      : <div className="m1-code-panel">
        <div className="m1-code-head">
          <b>{content.kind === "json" ? F19.formattedJson : F19.escapedText}</b>
          {folded && <span className="m1-code-excerpt">{F19.excerpt}</span>}
          <span className="m1-code-hint">{folded ? F19.excerptHint : F19.textHint}</span>
          <span className="m1-spacer" />
          <button type="button" className="m1-code-copy" onClick={() => onCopy?.(content.kind === "json" ? content.full : content.text, "artifact")}>
            {copied === "artifact" ? F19.copied : copied === "artifact:failed" ? F19.copyFailed : F19.copyFull(content.kind === "json" ? "JSON" : "text")}
          </button>
        </div>
        {content.kind === "json" ? <ExcerptBody tokens={tokens} onExpand={onExpand} /> : <pre className="m1-code-body" tabIndex={0}>{content.text}</pre>}
      </div>}
    {measured && <div className="m1-measured" data-testid="m1-measured"><span className="m1-measured-dot" /><span><b>{measured[0]}</b>{measured[1]}</span></div>}
  </article>;
}

function CurrentCard({ check, producer }: { check: Check | undefined; producer: string }) {
  return <StateCard19 name="current">
    <div className="m1-state19-block">
      <div className="m1-current">
        <span className="m1-current-tag">{F19.current}</span>
        <span className="m1-text12"><b>{F19.qualifying}</b> <b className="m1-nowrap">{check?.requirement.reference}</b></span>
        <Chip>{F19.illustrative}</Chip>
      </div>
      <div className="m1-obs-card">
        <ObservationHead id={F19.retestId.slice(1)} release={<span>{F19.releaseMissing}</span>} />
        <div className="m1-f19-facts">
          <div className="m1-f19-fact"><span className="m1-f19-label">{F19.producer}</span><span className="m1-obs-value"><span className="m1-obs-code">{producer}</span> <span className="m1-f19-warn">{F19.unverified}</span> <Chip>{PLANNED_SAMPLE}</Chip></span></div>
        </div>
        <div className="m1-obs-check">
          <div className="m1-f19-check-title"><span className="m1-code12">{check?.id}</span><span className="m1-pill10 ok">{F19.captured("PASS")}</span><span className="m1-pill10 teal">{F19.fresh}</span></div>
          <span className="m1-f19-ref-line"><span>{check?.requirement.framework} {DOT}</span> <b className="m1-code11">{check?.requirement.reference}</b> <span>{F19.validUntilInline.trim()}</span> <b className="m1-nowrap">{F19.sampleValidUntil}</b></span>
        </div>
      </div>
      <span className="m1-note145">{F19.currentNote}</span>
    </div>
  </StateCard19>;
}

function ExpiredCard({ bundle, check, now }: { bundle: EvidenceBundle; check: Check; now: number }) {
  const after = receivedAfterExpiry(bundle, [check]);
  return <StateCard19 name="expired">
    <div className="m1-state19-block">
      <div className="m1-expired-banner">
        <span className="m1-expired-text"><b>{F19.expired(expiredTime(check.validUntil) ?? "")}</b>{F19.expiredBody(check.verdict.toUpperCase())}</span>
        <a className="m1-expired-btn" href="/planning?view=connections">{F19.collectRetest}</a>
      </div>
      <div className="m1-obs-card">
        <ObservationHead id={bundle.event.run.id} release={<ReleaseMeta receipt={bundle.id} />} />
        <div className="m1-f19-facts">
          <div className="m1-f19-fact"><span className="m1-f19-label">{F19.producer}</span><span className="m1-obs-value"><span className="m1-obs-code">{bundle.event.run.producer}</span> <span className="m1-f19-warn">{F19.unverified}</span></span></div>
          <div className="m1-f19-fact half"><span className="m1-f19-label">{F19.observed}</span><span className="m1-obs-value">{fullTime(bundle.event.run.observedAt)}</span></div>
          <div className="m1-f19-fact half"><span className="m1-f19-label">{F19.received}</span><span className="m1-obs-value m1-col2"><span>{fullTime(bundle.receivedAt)}</span>{after && <span className="m1-f19-hint">{F19.receivedAfterExpiry(clockTime(after) ?? "")}</span>}</span></div>
        </div>
        <div className="m1-obs-check">
          <div className="m1-f19-check-title"><span className="m1-code12">{check.id}</span><span className={`m1-pill10 ${check.verdict === "pass" ? "ok" : "warn"}`}>{F19.captured(check.verdict.toUpperCase())}</span><span className="m1-pill10 warn">{freshnessLabel(checkState(bundle.event, check, now))}</span></div>
          <span className="m1-f19-ref-line"><span>{check.requirement.framework} {DOT}</span> <b className="m1-code11">{check.requirement.reference}</b> <span>{F19.validUntilInline.trim()}</span> <b className="m1-nowrap">{storedTime(check.validUntil)}</b></span>
        </div>
      </div>
    </div>
  </StateCard19>;
}

function VerifiedCard({ bundle }: { bundle: EvidenceBundle }) {
  return <StateCard19 name="verified">
    <div className="m1-state19-block">
      <div className="m1-obs-card">
        <ObservationHead id={bundle.event.run.id} release={<ReleaseMeta receipt={bundle.id} />} />
        <div className="m1-f19-facts">
          <div className="m1-f19-fact"><span className="m1-f19-label">{F19.producer}</span><span className="m1-obs-value"><span className="m1-obs-code">{bundle.event.run.producer}</span> <span className="m1-teal">{F19.verified}</span> <Chip>{PLANNED_SAMPLE}</Chip></span></div>
        </div>
      </div>
      <span className="m1-help145">{F19.verifiedNote}</span>
    </div>
  </StateCard19>;
}

function LoadingCard({ receipt }: { receipt: string }) {
  return <StateCard19 name="loading">
    <div className="m1-loading19" role="status">
      <div className="m1-row"><span className="m1-spinner" aria-hidden="true" /><span className="m1-f19-meta-text">{F19.checking}<span className="m1-code11">{receiptDigest(receipt)}</span>{ELLIPSIS}</span></div>
      <span className="m1-skel10" style={{ width: "70%" }} />
      <span className="m1-skel10" style={{ width: "55%" }} />
      <span className="m1-skel10" style={{ width: "62%" }} />
    </div>
  </StateCard19>;
}

function ErrorCard({ receipt, message, notFound, download }: { receipt: string; message: string; notFound: boolean; download: string }) {
  return <StateCard19 name="error">
    <div className="m1-state19-block">
      <span className="m1-error19-status">Retained bundle unavailable</span>
      <div className="m1-error19" role="alert" title={message} aria-label={message}>The bundle for receipt <span className="m1-code11">{receiptDigest(receipt)}</span> could not be read or verified. Nothing from this bundle is shown.</div>
      <span className="m1-help145">{F19.verifyRule}</span>
      <div className="m1-row m1-top">
        {notFound ? <button type="button" className="m1-btn30" disabled>{F19.downloadBundle}</button> : <a className="m1-btn30" href={download}>{F19.downloadBundle}</a>}
        <button type="button" className="m1-btn30" disabled title={F19.copyVerifyOff}>{F19.copyVerify}</button>
      </div>
    </div>
  </StateCard19>;
}

function FileList({ artifacts, download, onSelect }: { artifacts: Artifact[]; download: string; onSelect?: (name: string) => void }) {
  return <StateCard19 name="empty"><div className="m1-filelist" data-testid="m1-file-list">
    <div className="m1-f19-head"><h2 className="m1-f19-h">{F19.artifacts}</h2><span className="m1-f19-meta">{F19.noneSelected}</span></div>
    {artifacts.map((artifact) => <div key={artifact.name} className="m1-filelist-row">
      <span className="m1-filelist-name">{artifact.name}</span>
      <span className="m1-muted">{artifact.mediaType}</span>
      <span className="m1-spacer" />
      <button type="button" className="m1-filelist-action" aria-label={`${F19.view} ${artifact.name}`} onClick={() => onSelect?.(artifact.name)}>{F19.view}</button>
      <a className="m1-filelist-action" aria-label={`Download ${artifact.name}`} href={`${download}&${new URLSearchParams({ artifact: artifact.name })}`}>{F19.downloadGlyph}</a>
    </div>)}
  </div></StateCard19>;
}

export function Frame19View(props: Frame19Props) {
  const { receipt, download, load, now, checkId, selected, expanded, limitationsOpen, popover, copied, source, onSelect, onExpand, onToggleLimitations, onPopover, onCopy } = props;
  if (load.kind === "loading") return <main className="m1-f19" data-testid="observation-viewer"><div className="m1-f19-center"><LoadingCard receipt={receipt} /></div></main>;
  if (load.kind === "error") return <main className="m1-f19" data-testid="observation-viewer"><div className="m1-f19-center"><ErrorCard receipt={receipt} message={load.message} notFound={load.notFound} download={download} /></div></main>;
  const bundle = load.bundle;
  const event = bundle.event;
  const checks = event.checks.filter((c) => !checkId || c.id === checkId);
  const first = checks[0];
  const stale = checks.find((c) => checkState(event, c, now) === "stale");
  const after = receivedAfterExpiry(bundle, checks);
  const artifact = event.artifacts.find((a) => a.name === selected);
  const controlFor = artifact ? (event.checks.find((c) => c.artifacts.includes(artifact.name)) ?? first)?.requirement.reference ?? null : null;
  const select = (name: string) => onSelect?.(name === selected ? undefined : name);
  return <main className="m1-f19" data-testid="observation-viewer">
    {first && <div className="m1-history" data-testid="m1-history">
      <span className="m1-history-tag">{F19.history}</span>
      <span className="m1-history-text"><b>{F19.superseded}</b> <span className="m1-code115">{F19.retestId}</span> {OUT}</span>
      <Chip>{PLANNED_SAMPLE}</Chip>
      <span className="m1-help145">{F19.stays(first.verdict.toUpperCase())}</span>
      <span className="m1-spacer" />
      <button type="button" className="m1-history-btn" aria-haspopup="dialog" onClick={() => onPopover?.("current")}>{F19.openRetest}</button>
    </div>}
    <div className="m1-f19-cols">
      <div className="m1-f19-left">
        <section className="m1-f19-obs" aria-label={F19.observation}>
          <ObservationHead id={event.run.id} release={<ReleaseMeta receipt={bundle.id} />} />
          <div className="m1-f19-facts">
            <div className="m1-f19-fact"><span className="m1-f19-label">{F19.subject}</span><span className="m1-f19-value">{event.subject.kind} {DOT} <span className="m1-f19-code">{event.subject.id}</span></span></div>
            <div className="m1-f19-fact"><span className="m1-f19-label">{F19.revision}</span><span className="m1-f19-value"><span className="m1-f19-code" title={event.subject.revision}>{revisionLabel(event.subject.revision)}</span> <CopyButton value={event.subject.revision} label="revision" copied={copied} onCopy={onCopy} /></span></div>
            <div className="m1-f19-fact"><span className="m1-f19-label">{F19.producer}</span><span className="m1-f19-value"><span className="m1-f19-code">{event.run.producer}</span> <span className="m1-f19-warn">{F19.unverified}</span></span></div>
            <div className="m1-f19-fact half"><span className="m1-f19-label">{F19.observed}</span><span className="m1-f19-value">{fullTime(event.run.observedAt)}</span></div>
            <div className="m1-f19-fact half"><span className="m1-f19-label">{F19.received}</span><span className="m1-f19-value">{fullTime(bundle.receivedAt)}</span>{after && <span className="m1-f19-hint" data-testid="m1-received-after-expiry">{F19.receivedAfterExpiry(clockTime(after) ?? "")}</span>}</div>
            <div className="m1-f19-fact"><span className="m1-f19-label">{F19.receipt}</span><span className="m1-f19-value"><span className="m1-f19-code500" title={bundle.id}>{receiptDigest(bundle.id)}</span> <CopyButton value={bundle.id} label="receipt" copied={copied} onCopy={onCopy} /></span></div>
          </div>
        </section>
        <section className="m1-f19-card" aria-label={F19.checks}>
          <div className="m1-f19-head"><h2 className="m1-f19-h">{F19.checks}</h2><span className="m1-f19-meta">{F19.checkCount(checks.length)}</span></div>
          {checks.map((check) => {
            const state = checkState(event, check, now);
            const label = freshnessLabel(state);
            return <article key={check.id} className="m1-f19-check" data-testid="retained-check">
              <div className="m1-f19-check-title">
                <h3 className="m1-f19-check-id">{check.id}</h3>
                <span className={verdictClass(check.verdict)}>{F19.captured(check.verdict.toUpperCase())}</span>
                {state === "stale"
                  ? <button type="button" className="m1-f19-expired" aria-haspopup="dialog" onClick={() => onPopover?.("expired")}>{label}</button>
                  : <span className={stateClass(state)}>{label}</span>}
              </div>
              <span className="m1-f19-desc">{check.description}</span>
              <dl className="m1-f19-grid">
                <dt className="m1-muted">{F19.framework}</dt>
                <dd>{check.requirement.framework} {DOT} <b className="m1-f19-ref">{check.requirement.reference}</b> {DOT} v{check.version}</dd>
                <dt className="m1-muted">{F19.result}</dt>
                <dd>{check.requirement.objective}</dd>
                <dt className="m1-muted">{F19.validUntil}</dt>
                <dd><b>{storedTime(check.validUntil)}</b> <span className={state === "stale" ? "m1-f19-warn-plain" : "m1-muted"}>{DOT} {label.toLowerCase()}</span></dd>
              </dl>
              <div className="m1-files">{check.artifacts.map((name) => <button type="button" key={name} className="m1-file" aria-pressed={name === selected} onClick={() => select(name)}><span className="m1-file-mark" aria-hidden="true" />{name}</button>)}</div>
            </article>;
          })}
          {checkId && checks.length === 0 && <p role="alert" className="m1-error19">{F19.notFoundCheck}</p>}
        </section>
      </div>
      <div className="m1-f19-right">
        {selected
          ? <section className="m1-f19-card grow" aria-label={F19.artifacts}>
            <div className="m1-f19-head"><h2 className="m1-f19-h">{F19.artifacts}</h2><span className="m1-f19-meta">{F19.artifactsCount(event.artifacts.length)}</span></div>
            <div className="m1-files">{event.artifacts.map((a) => <button type="button" key={a.name} className="m1-file tall" aria-pressed={a.name === selected} onClick={() => select(a.name)}><span className="m1-file-mark" aria-hidden="true" />{a.name}</button>)}</div>
            {!artifact && <p role="alert" className="m1-error19">{F19.notFoundArtifact}</p>}
            {artifact && <ArtifactDetail artifact={artifact} controlFor={controlFor} download={download} expanded={expanded} copied={copied} source={source} onExpand={onExpand} onCopy={onCopy} />}
          </section>
          : <section className="m1-f19-empty" aria-label={F19.artifacts}><FileList artifacts={event.artifacts} download={download} onSelect={(name) => onSelect?.(name)} /></section>}
        <section className="m1-f19-card" aria-label={F19.limitations}>
          <div className="m1-f19-limits">
            <h2 className="m1-f19-limits-title">{F19.limitations}</h2>
            <button type="button" className="m1-f19-link" aria-expanded={limitationsOpen} onClick={onToggleLimitations}>{limitationsOpen ? F19.hideLimitations(event.limitations.length) : F19.showLimitations(event.limitations.length)}</button>
          </div>
          {limitationsOpen && <ul className="m1-f19-list">{event.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        </section>
      </div>
    </div>
    {popover && <div className="m1-popover" role="dialog" aria-label={F19.popoverLabel[popover]}>
      <button type="button" className="m1-popover-close" onClick={() => onPopover?.(null)}>{F19.close}</button>
      {popover === "current" && <CurrentCard check={first} producer={event.run.producer} />}
      {popover === "expired" && stale && <ExpiredCard bundle={bundle} check={stale} now={now} />}
      {popover === "verified" && <VerifiedCard bundle={bundle} />}
    </div>}
  </main>;
}

export function Frame19Toolbar({ ready, download, onPopover }: { ready: boolean; download: string; onPopover?: (popover: Frame19Popover) => void }) {
  return <div className="m1-toolbar">
    <a className="m1-back" href="/planning?view=release">{F19.back} <span className="m1-kbd">{F19.esc}</span></a>
    <h1 className="m1-toolbar-title">{F19.title}</h1>
    <button type="button" className="m1-producer-pill" aria-haspopup="dialog" disabled={!ready} onClick={() => onPopover?.("verified")}>{F19.producerUnverified}</button>
    <div className="m1-toolbar-text">
      <span className="m1-toolbar-sub">{F19.subtitle}</span>
      <span className="m1-toolbar-honesty" data-testid="m1-honesty">{HONESTY}</span>
    </div>
    <span className="m1-spacer" />
    {ready && <a className="m1-btn30" href={download}>{F19.downloadBundle}</a>}
  </div>;
}

export function Frame19Screen({ header, workspace, buildSha, ...props }: Frame19Props & { header: M1Header; workspace: Workspace; buildSha: string }) {
  return <M1Chrome header={header} tab="release" workspace={workspace} buildSha={buildSha} testId="m1-frame19">
    <Frame19Toolbar ready={props.load.kind === "ready"} download={props.download} onPopover={props.onPopover} />
    <Frame19View {...props} />
  </M1Chrome>;
}

/** Loads the retained bundle; the server recomputes the receipt digest on every read. */
export function useRetainedBundle(download: string, artifactName?: string, checkId?: string) {
  const [load, setLoad] = useState<Frame19Load>({ kind: "loading" });
  const [selected, setSelected] = useState<string | undefined>(artifactName);
  useEffect(() => {
    const abort = new AbortController();
    setLoad({ kind: "loading" });
    void fetch(download, { credentials: "same-origin", cache: "no-store", signal: abort.signal }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        const notFound = response.status === 404;
        setLoad({ kind: "error", notFound, message: notFound ? F19.notFound : `${F19.unavailable}${body?.error ? ` ${body.error}` : ""}` });
        return;
      }
      const bundle = await response.json() as EvidenceBundle;
      setSelected(initialArtifact(bundle.event, artifactName, checkId));
      setLoad({ kind: "ready", bundle });
    }).catch(() => {
      if (!abort.signal.aborted) setLoad({ kind: "error", notFound: false, message: F19.unavailable });
    });
    return () => abort.abort();
  }, [download, artifactName, checkId]);
  return { load, selected, setSelected };
}

export function useFrame19Controls() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [limitationsOpen, setLimitationsOpen] = useState(false);
  const [popover, setPopover] = useState<Frame19Popover>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (popover) { setPopover(null); return; }
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,details")) return;
      window.location.assign("/planning?view=release");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [popover]);
  const onCopy = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(`${label}:failed`);
    }
  }, []);
  const onExpand = useCallback((path: string) => setExpanded((prior) => new Set([...prior, path])), []);
  return { expanded, setExpanded, limitationsOpen, setLimitationsOpen, popover, setPopover, copied, onCopy, onExpand, now };
}
