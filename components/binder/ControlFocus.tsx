"use client";

import React, { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  compactConstraint,
  descendantParams,
  directedLinksFor,
  evidenceColumnKicker,
  itemEvidenceLinks,
  openParamChip,
  packageStillFails,
  paramChip,
  subsetBaselineNote,
  proseSegments, resolvedStatementProse,
  statementAddressed,
} from "@/lib/aegis/map-view";
import { EVIDENCE_COLUMN_HEADER, nextStageSize, placeCardColumn, type StageSize } from "@/lib/aegis/map-layout";
import { busRoute, treePath } from "@/lib/aegis/selected-tree";
import type { ControlView, PackageState, StatementNode, StatementParamRef } from "@/lib/aegis/types";
import { gitlabArtifactUrl, pipelineMappingForControl, type PipelineEvidence } from "@/lib/aegis/pipeline-evidence";

/**
 * Size of a scroll box, measured from its border box less its scrollbar gutter. The box
 * size comes from its parent's layout, so what renders inside it cannot feed back into
 * the next measurement. `mount` changes when the observed node remounts.
 */
export function useStageSize(ref: RefObject<HTMLElement | null>, floor: { width: number; height: number }, mount = ""): StageSize {
  const [size, setSize] = useState<StageSize>({ width: Math.max(floor.width, 1280), height: floor.height, gutter: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      setSize((previous) => nextStageSize(previous, {
        width: rect.width - borders,
        height: rect.height,
        gutter: node.offsetWidth - node.clientWidth - borders,
      }, floor));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, floor.width, floor.height, mount]);
  return size;
}

const BOARD_FLOOR = { width: 1, height: 1 };

type Props = {
  pkg: PackageState;
  pipelineEvidence?: PipelineEvidence;
  control: ControlView;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onLeaveFocus: () => void;
  onOpenEvidence?: (id: string) => void;
  onOpenMappedControl?: (id: string) => void;
};

type Wire = {
  key: string;
  d: string;
  rel: string;
  from?: string;
  to?: string;
  width: number;
  color: string;
  opacity: number;
};

export function ControlFocus({ pkg, pipelineEvidence, control, selectedItemId, onSelectItem, onLeaveFocus, onOpenEvidence, onOpenMappedControl }: Props) {
  const statements = pkg.map.statements[control.id] ?? null;
  const items = statements?.items ?? [];
  const facts = pkg.map.byControl[control.id] ?? null;
  const links = pkg.map.available ? directedLinksFor(pkg.map.edges, control.id) : null;
  const family = pkg.map.families.find((item) => item.id === control.family);
  const evidenceLinks = itemEvidenceLinks(control);
  const linkKey = evidenceLinks.map((link) => `${link.statementId}:${link.evidenceId}`).join("|");
  const mapped = evidenceLinks.length > 0;
  const addressed = items.filter((item) => statementAddressed(control, item.id)).length;
  const failLine = packageStillFails(control.id, pkg.controls, pkg.gate.status);
  const boardRef = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  const [boardSize, setBoardSize] = useState({ width: 1100, height: 640 });
  const [evidenceTop, setEvidenceTop] = useState<Record<string, number>>({});
  const boardBox = useStageSize(boardRef, BOARD_FLOOR);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const origin = board.getBoundingClientRect();
    const rows = [...board.querySelectorAll<HTMLElement>("[data-item-id]")];
    const next: Wire[] = [];
    const card = board.querySelector<HTMLElement>("[data-testid='level2-control']");
    if (card && rows.length > 0) {
      const box = card.getBoundingClientRect();
      const x1 = box.right - origin.left;
      const y1 = box.top - origin.top + box.height / 2;
      const trunk = (x1 + Math.min(...rows.map((row) => row.getBoundingClientRect().left - origin.left))) / 2;
      for (const row of rows) {
        const rowBox = row.getBoundingClientRect();
        next.push({
          key: `fan-${row.dataset.itemId}`,
          d: treePath(busRoute({ x: x1, y: y1 }, { x: rowBox.left - origin.left, y: rowBox.top - origin.top + rowBox.height / 2 }, trunk)),
          rel: "statement-fan",
          from: control.id,
          to: row.dataset.itemId,
          width: 1.3,
          color: "#b9aefc",
          opacity: 1,
        });
      }
    }
    const tops: Record<string, number> = {};
    if (mapped) {
      const byEvidence = new Map<string, number[]>();
      for (const link of evidenceLinks) {
        const row = rows.find((item) => item.dataset.itemId === link.statementId);
        if (!row) continue;
        const box = row.getBoundingClientRect();
        const ry = box.top - origin.top + box.height / 2;
        const list = byEvidence.get(link.evidenceId) ?? [];
        list.push(ry);
        byEvidence.set(link.evidenceId, list);
      }
      const cardH = 52;
      const count = byEvidence.size;
      const stack = EVIDENCE_COLUMN_HEADER + Math.max(0, count - 1) * (cardH + 18) + cardH;
      const placed = placeCardColumn(
        [...byEvidence.entries()].map(([evidenceId, centers]) => ({
          id: evidenceId,
          ideal: mean(centers) - cardH / 2,
          weight: centers.length,
        })),
        cardH,
        18,
        { top: EVIDENCE_COLUMN_HEADER, bottom: Math.max(stack, board.clientHeight - 8) },
      );
      for (const card of placed) tops[card.id] = card.top;
      const cardLeft = origin.width - 16 - 220;
      const rowRight = Math.max(...rows.map((row) => row.getBoundingClientRect().right - origin.left));
      // Each evidence card gathers its statement rows on its own trunk.
      const cards = [...byEvidence.keys()];
      const trunks = new Map(cards.map((id, index) => [id, (rowRight + cardLeft) / 2 + (index - (cards.length - 1) / 2) * Math.min(6, (cardLeft - rowRight - 16) / Math.max(1, cards.length))]));
      for (const link of evidenceLinks) {
        const row = rows.find((item) => item.dataset.itemId === link.statementId);
        const top = tops[link.evidenceId];
        if (!row || top == null) continue;
        const box = row.getBoundingClientRect();
        const selected = selectedItemId === link.statementId;
        const quiet = Boolean(selectedItemId) && !selected;
        next.push({
          key: `ev-${link.statementId}-${link.evidenceId}`,
          d: treePath(busRoute({ x: box.right - origin.left, y: box.top - origin.top + box.height / 2 }, { x: cardLeft, y: top + 26 }, trunks.get(link.evidenceId)!)),
          rel: "item-evidence",
          from: link.statementId,
          to: link.evidenceId,
          width: selected ? 2 : 1.25,
          color: "#3b7fc4",
          opacity: quiet ? 0.35 : 1,
        });
      }
    }
    setWires(next);
    setEvidenceTop(tops);
    setBoardSize({ width: Math.max(1, board.clientWidth), height: Math.max(1, board.scrollHeight) });
    // linkKey stands in for evidenceLinks, which is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control.id, selectedItemId, mapped, items.length, linkKey, boardBox.width, boardBox.height]);

  const coverage = control.rollupState === "blank"
    ? "Blank"
    : control.rollupState === "recorded"
      ? `Evidence linked · coverage only${control.rollupReleaseId ? ` · #${control.rollupReleaseId}` : ""}`
      : control.itemStatements.length > 0
        ? `${control.complete ? "✓ fields complete" : "✕ fields incomplete"} · ${addressed}/${items.length} items`
        : control.complete ? "✓ fields complete" : "✕ fields incomplete";

  return (
    <div className="l2" data-testid="level2-focus">
      <div className="l2-bar">
        <button type="button" className="l2-back" data-testid="level2-back" onClick={onLeaveFocus}>
          ← Map <kbd>Esc</kbd>
        </button>
        <nav className="l2-crumb" aria-label="Focus breadcrumb" data-testid="level2-breadcrumb">
          <button type="button" onClick={onLeaveFocus}>Package map</button>
          <span aria-hidden="true">›</span>
          <span>{control.family}</span>
          <span aria-hidden="true">›</span>
          <strong className="mono">{control.id}</strong>
        </nav>
        <span className="l2-badge">Level 2 · focus</span>
      </div>
      {!control.rollupState && failLine ? <p className="l2-package-fail" data-testid="package-still-fails">{failLine}</p> : null}
      {pipelineEvidence && !control.rollupState && <PipelineContext record={pipelineEvidence} control={control} pkg={pkg} onOpenControl={onOpenMappedControl} />}
      <div className="l2-board" ref={boardRef}>
        <svg className="l2-wires" width={boardSize.width} height={boardSize.height} viewBox={`0 0 ${boardSize.width} ${boardSize.height}`} aria-hidden="true">
          <defs><marker id="l2-evidence-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 1 L10 5 L0 9 Z" fill="#3b7fc4" /></marker></defs>
          {wires.map((wire) => (
            <path
              key={wire.key}
              data-rel={wire.rel}
              data-from={wire.from}
              data-to={wire.to}
              d={wire.d}
              fill="none"
              stroke={wire.color}
              strokeWidth={wire.width}
              strokeLinecap="round"
              opacity={wire.opacity}
              markerEnd={wire.rel === "item-evidence" ? "url(#l2-evidence-arrow)" : undefined}
            />
          ))}
        </svg>
        <div className="l2-rail">
          <section className="l2-links" data-testid="level2-links">
            <span className="l2-kicker">Level 1 links</span>
            {links ? (
              <>
                <LinkLine testId="focus-mutual" mark="⇄" ids={links.mutual.map((link) => link.otherId)} />
                <LinkLine testId="focus-outbound" mark="→" ids={links.outbound.map((link) => link.otherId)} />
                <LinkLine testId="focus-reverse" mark="←" ids={links.reverse.map((link) => link.otherId)} />
                {links.mutual.length + links.outbound.length + links.reverse.length === 0 && (
                  <span>No in-package related links.</span>
                )}
              </>
            ) : (
              <span>{pkg.map.note}</span>
            )}
            {facts && (
              <span data-testid="focus-outside">
                {facts.outOfSubsetCount} related {facts.outOfSubsetCount === 1 ? "control" : "controls"} outside this subset
              </span>
            )}
            <button type="button" className="l2-show" onClick={onLeaveFocus}>Show on map</button>
          </section>
          <article className={`l2-control ${control.rollupState ? "" : control.complete ? "ok" : "open"}`} data-testid="level2-control" data-rollup={control.rollupState}>
            <span className="mono l2-cid">{control.id}</span>
            <strong>{control.title}</strong>
            <span>{control.family}{family ? ` · ${family.title}` : ""}</span>
            {!control.rollupState && <span>Role · {control.responsibleRole.trim() || "no role"}</span>}
            <span className={control.rollupState ? "" : control.complete ? "l2-ok" : "l2-bad"} data-testid="level2-item-coverage">{coverage}</span>
          </article>
          {!control.rollupState && !mapped && control.evidence.length > 0 && <section className="l2-control-evidence"><span className="l2-kicker">Control-level evidence</span>{control.evidence.map((item) => <button key={item.id} type="button" onClick={() => onOpenEvidence?.(item.id)}><span className="mono">{item.displayId ?? item.id}</span><strong>{item.title}</strong></button>)}</section>}
          <section className="l2-enh" data-testid="focus-enhancements">
            <span className="l2-kicker">Required enhancements · FedRAMP Moderate · not in subset</span>
            <p className="l2-subset" data-testid="subset-note">{subsetBaselineNote(pkg.map.subsetMatch, pkg.inScopeCount)}</p>
            {facts && facts.requiredEnhancements.length > 0 ? (
              <ul>
                {facts.requiredEnhancements.map((item) => (
                  <li key={item.id} data-enhancement-id={item.id} title={item.title}>
                    <span className="mono">{enhMark(item.label)}</span>
                    <span>{item.title}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No Moderate enhancements outside this subset.</p>
            )}
          </section>
        </div>
        <div className="l2-items">
          <p className="l2-kicker">Statement · {items.length} {items.length === 1 ? "item" : "items"} · 800-53 Rev {pkg.map.catalogVersion ?? "5"}</p>
          {items.length === 0 ? (
            <p className="l2-empty">No statement items in the Rev5 catalog for this control.</p>
          ) : (
            <ol className="l2-rows">
              {items.map((item) => (
                <StatementRow
                  key={item.id}
                  item={item}
                  addressed={statementAddressed(control, item.id)}
                  selected={item.id === selectedItemId}
                  onSelect={() => onSelectItem(item.id)}
                />
              ))}
            </ol>
          )}
        </div>
        {!control.rollupState && <div className="l2-evidence" data-testid="level2-evidence">
          <p className="l2-kicker">{evidenceColumnKicker(evidenceLinks.length)}</p>
          {!mapped && (
            <p className="l2-note">No item-level evidence links in this package. Evidence remains associated with {control.id}, not its individual statements.</p>
          )}
          {control.evidence.length === 0 ? (
            <p>No evidence linked.</p>
          ) : mapped ? (
            control.evidence.map((item) => (
              <button
                key={item.id}
                type="button"
                className="l2-ev-node"
                data-evidence-id={item.id}
                style={{ top: evidenceTop[item.id] ?? 0 }}
                onClick={() => onOpenEvidence?.(item.id)}
              >
                <span className="l2-ev-head">
                  <span className="mono">{item.displayId ?? item.id}</span>
                  <span className="l2-supports">{supportLine(control, item.id, items)}</span>
                </span>
                <strong>{item.title}</strong>
              </button>
            ))
          ) : null}
        </div>}
      </div>
      <div className="l2-legend" aria-label="Level 2 legend" data-testid="level2-legend">
        <span><i className="l2-dot filled" /> by-statement entry</span>
        <span><i className="l2-dot hollow" /> not addressed</span>
        <span><i className="l2-chip constraint">constraint</i> FedRAMP constraint</span>
        <span><i className="l2-chip open" title="organization defined parameter">odp</i> org-defined, no constraint</span>
        <span><i className="l2-obj" title="assessment objectives from 800-53A">obj n</i> 800-53A objectives</span>
        <span><i className="l2-fan" /> statement</span>
        <span><i className="l2-link" /> evidence link</span>
        <span><i className="l2-dash" /> required, not in subset</span>
        <span><abbr title="implemented requirement">IR</abbr> implemented requirement</span>
      </div>
    </div>
  );
}

function PipelineContext({ record, control, pkg, onOpenControl }: {
  record: PipelineEvidence; control: ControlView; pkg: PackageState; onOpenControl?: (id: string) => void;
}) {
  if (control.rollupState) {
    return <section className="l2-pipeline" aria-label="Pipeline evidence context" data-testid="level2-pipeline">
      <div className="l2-pipeline-main">
        <div className="l2-pipeline-heading"><span className="l2-kicker">Current result{control.rollupReleaseId ? ` · #${control.rollupReleaseId}` : ""}</span><a href="/planning/pipeline">Full release view ↗</a></div>
        {control.rollupState === "recorded" ? <>
          <strong>{control.id} · recorded</strong>
          {control.implementation ? <p>{control.implementation}</p> : null}
          <div className="l2-pipeline-artifacts">{control.evidence.map((item) => item.href ? <a key={item.id} href={item.href} target="_blank" rel="noopener noreferrer">{item.title} ↗</a> : <span key={item.id}>{item.title}</span>)}</div>
        </> : <p>Blank. No stored evidence for {control.id}.</p>}
        <small>The newer stored result replaces an older one for this control. Blank is not a pass. This is not an authorization.</small>
      </div>
    </section>;
  }
  const mapping = pipelineMappingForControl(record, control.id);
  const inPackage = new Set(pkg.controls.map((item) => item.id));
  return <section className="l2-pipeline" aria-label="Pipeline evidence context" data-testid="level2-pipeline">
    <div className="l2-pipeline-main">
      <div className="l2-pipeline-heading"><span className="l2-kicker">Pipeline context · #{record.pipelineId}</span><a href="/planning/pipeline">Full release view ↗</a></div>
      {mapping ? <><strong>{control.id} · {mapping.family} mapping</strong><div className="l2-pipeline-artifacts">{mapping.evidence.map((name) => {
        const href = gitlabArtifactUrl(record, name);
        return href ? <a key={name} href={href} target="_blank" rel="noopener noreferrer">{name.endsWith(".json") || name.endsWith(".yaml") ? name : `${name}.json`} ↗</a> : <span key={name}>{name}</span>;
      })}</div></> : <p>No direct mapping for {control.id} in this release.</p>}
      <small>Control-level links · not proof of effectiveness.</small>
      <details className="l2-pipeline-details"><summary>Mapping & scope</summary>{mapping && <p>{mapping.coverage}</p>}<p>CI assessment support only · separate from this SSP’s evidence and statement-item links · does not change completeness. Effectiveness is not established by these links.</p></details>
    </div>
    <details className="l2-pipeline-families"><summary>Other mapped families ({record.families.length - (mapping ? 1 : 0)})</summary><div>{record.families.filter((family) => family !== mapping).map((family) => <div key={family.family}><b>{family.family}</b><span>{family.controls.map((id, index) => <span key={id}>{index > 0 ? " · " : ""}{inPackage.has(id) && onOpenControl ? <button type="button" onClick={() => onOpenControl(id)}>{id} ↗</button> : id}</span>)}</span></div>)}</div></details>
  </section>;
}

export function StatementRow({
  item,
  addressed,
  selected,
  onSelect,
  releaseOnly = false,
  evidenceLabel,
}: {
  releaseOnly?: boolean;
  evidenceLabel?: string;
  item: StatementNode;
  addressed: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const params = descendantParams(item);
  const label = item.label ?? item.id;
  return (
    <li>
      <button
        type="button"
        className={`l2-row ${selected ? "selected" : ""}`}
        data-testid={`statement-${label.replace(/\.$/, "")}`}
        data-item-id={item.id}
        data-addressed={addressed ? "true" : "false"}
        data-objectives={item.objectiveCount}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <i className={`l2-dot ${addressed ? "filled" : "hollow"}`} aria-hidden="true" />
        <span className="mono l2-label">{label}</span>
        <span className="l2-prose" title={resolvedStatementProse(item.prose,Object.fromEntries(params.map(p=>[p.paramId,p])))}>
          <Prose text={item.prose} index={params} />
          {item.children.length > 0 && <em> · {item.children.length} sub-items</em>}
        </span>
        <span className="l2-chips">
          {params.map((param) => {
            const chip = paramChip(item.label, param);
            const text = chip.tone === "constraint" && param.constraint
              ? `${chipWhere(item.label, param)} = ${compactConstraint(param.constraint)}`
              : chip.text;
            const title = chip.tone === "open" ? "organization defined parameter" : param.constraint ?? param.paramId;
            return (
              <span key={`${param.itemId}-${param.paramId}`} className={`l2-chip ${chip.tone}`} title={title}>
                {text}
                {param.constraint ? <span className="sr-only">{param.constraint}</span> : null}
              </span>
            );
          })}
        </span>
        {releaseOnly && <span className="round21-item-evidence">{evidenceLabel ?? "no item-level evidence"}</span>}
        <span className="l2-obj" title={`${item.objectiveCount} assessment objectives from 800-53A`}>obj {item.objectiveCount}</span>
      </button>
    </li>
  );
}

function chipWhere(parentLabel: string | null, param: StatementParamRef): string {
  const chip = paramChip(parentLabel, param);
  const head = chip.text.split("·")[0]?.trim();
  return head || openParamChip(param.paramId);
}

function Prose({
  text,
  index,
}: {
  text: string;
  index: Array<{ paramId: string; label: string; constraint: string | null }>;
}) {
  const lookup: Record<string, { label: string; constraint: string | null }> = {};
  for (const param of index) lookup[param.paramId] = { label: param.label, constraint: param.constraint };
  return (
    <>
      {proseSegments(text, lookup).map((segment, indexKey) => {
        if (segment.kind === "text") return <span key={indexKey}>{segment.text}</span>;
        const title = segment.kind === "open" ? "organization defined parameter" : segment.text;
        return (
          <span key={indexKey} className="l2-odp" title={title}>‹ {segment.text} ›</span>
        );
      })}
    </>
  );
}

function LinkLine({ testId, mark, ids }: { testId: string; mark: string; ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <span data-testid={testId}>
      {mark} {ids.join(" ")}
    </span>
  );
}

function supportLine(control: ControlView, evidenceId: string, items: StatementNode[]): string {
  const labels = itemEvidenceLinks(control)
    .filter((link) => link.evidenceId === evidenceId)
    .map((link) => items.find((item) => item.id === link.statementId)?.label ?? "")
    .filter(Boolean);
  return labels.length ? `supports ${labels.join(" ")}` : "";
}

function enhMark(label: string): string {
  const match = /\(([^)]+)\)$/.exec(label);
  return match ? `(${match[1]})` : label;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
