"use client";

import {SourceRepo,SystemSources} from "./SourceRepo";
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { findStatement, itemEvidenceLinks, proseSegments, type ProseSegment } from "@/lib/aegis/map-view";
import { busRoute, treePath } from "@/lib/aegis/selected-tree";
import { useStageSize } from "./ControlFocus";
import type { PackageState } from "@/lib/aegis/types";

type Props = {
  pkg: PackageState;
  evidenceId: string;
  returnControlId?: string;
  onLeave: () => void;
  onOpenControl: (controlId: string, itemId: string | null) => void;
};

type Row = {
  key: string;
  controlId: string;
  controlTitle: string;
  itemId: string | null;
  label: string;
  labelTitle: string;
  prose: string;
  index: Record<string, { label: string; constraint: string | null }>;
};

type Wire = { key: string; d: string };

const BOARD_FLOOR = { width: 1, height: 1 };

export function EvidenceFocus({ pkg, evidenceId, returnControlId, onLeave, onOpenControl }: Props) {
  const boardRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const rows = useMemo(() => rowsFor(pkg, evidenceId), [pkg, evidenceId]);
  const resource = pkg.controls.flatMap((control) => control.evidence).find((item) => item.id === evidenceId) ?? null;
  const [wires, setWires] = useState<Wire[]>([]);
  const [cardTop, setCardTop] = useState(24);
  const [boardSize, setBoardSize] = useState({ width: 1100, height: 640 });
  const boardBox = useStageSize(boardRef, BOARD_FLOOR);

  useLayoutEffect(() => {
    const board = boardRef.current;
    const card = cardRef.current;
    if (!board || !card) return;
    const origin = board.getBoundingClientRect();
    const rowNodes = [...board.querySelectorAll<HTMLElement>("[data-focus-row]")];
    const centers = rowNodes.map((row) => {
      const box = row.getBoundingClientRect();
      return box.top - origin.top + box.height / 2;
    });
    const meanY = centers.length ? centers.reduce((sum, value) => sum + value, 0) / centers.length : 80;
    const top = Math.max(12, meanY - 75);
    const cardBox = { left: origin.width - 16 - 220, cy: top + 75 };
    const rowRight = Math.max(...rowNodes.map((row) => row.getBoundingClientRect().right - origin.left));
    const next = rowNodes.map((row, index) => {
      const box = row.getBoundingClientRect();
      const port = spread(cardBox.cy - 60, 120, rowNodes.length, index);
      return {
        key: row.dataset.focusRow ?? String(index),
        d: treePath(busRoute({ x: box.right - origin.left, y: centers[index] ?? port }, { x: cardBox.left, y: port }, (rowRight + cardBox.left) / 2)),
      };
    });
    setCardTop(top);
    setWires(next);
    setBoardSize({ width: Math.max(1, board.clientWidth), height: Math.max(1, board.scrollHeight) });
  }, [evidenceId, rows, boardBox.width, boardBox.height]);

  return (
    <div className="l2" data-testid="evidence-focus">
      <div className="l2-bar">
        <button type="button" className="l2-back" onClick={onLeave}>
          ← {returnControlId ? `${returnControlId} · Level 2` : "Map"} <kbd>Esc</kbd>
        </button>
        <nav className="l2-crumb" aria-label="Evidence focus breadcrumb" data-testid="evidence-breadcrumb">
          <button type="button" onClick={onLeave}>{returnControlId ?? "Package map"}</button>
          <span aria-hidden="true">›</span>
          <span>Evidence</span>
          <span aria-hidden="true">›</span>
          <strong className="mono">{resource?.displayId ?? evidenceId}</strong>
        </nav>
        <span className="l2-badge">Level 2 · evidence focus</span>
      </div>
      <div className="l2-board ev-board" ref={boardRef}>
        <svg className="l2-wires" width={boardSize.width} height={boardSize.height} viewBox={`0 0 ${boardSize.width} ${boardSize.height}`} aria-hidden="true">
          <defs><marker id="evfocus-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 1 L10 5 L0 9 Z" fill="#3b7fc4" /></marker></defs>
          {wires.map((wire) => (
            <path
              key={wire.key}
              data-rel="evidence-focus"
              data-to={evidenceId}
              d={wire.d}
              fill="none"
              stroke="#3b7fc4"
              strokeWidth={1.25}
              strokeLinecap="round"
              markerEnd="url(#evfocus-arrow)"
            />
          ))}
        </svg>
        <div className="ev-rows">
          {rows.map((row, index) => {
            const showControl = index === 0 || rows[index - 1]?.controlId !== row.controlId;
            return (
              <div key={row.key} className="ev-group">
                {showControl && (
                  <button type="button" className="ev-control" onClick={() => onOpenControl(row.controlId, null)}>
                    <span className="mono">{row.controlId}</span>
                    <strong>{row.controlTitle}</strong>
                  </button>
                )}
                <button
                  type="button"
                  className="l2-row"
                  data-focus-row={row.key}
                  data-item-id={row.itemId ?? undefined}
                  onClick={() => onOpenControl(row.controlId, row.itemId)}
                >
                  <span className="mono l2-label" title={row.labelTitle}>{row.label}</span>
                  <span className="l2-prose">
                    <FocusProse prose={row.prose} index={row.index} />
                  </span>
                </button>
              </div>
            );
          })}
          {rows.length === 0 && <p className="l2-empty">No controls link this evidence.</p>}
        </div>
        <article
          ref={cardRef}
          className="l2-control ev-focus-card"
          data-testid="evidence-focus-card"
          style={{ top: cardTop }}
        >
          <span className="mono l2-cid">{resource?.displayId ?? evidenceId}</span>
          <strong>{resource?.title ?? evidenceId}</strong>
          {resource?.source ? <SourceRepo source={resource.source}/> : <SystemSources sources={resource?.systemSources}/>}
          <span>{resource?.href || "No href"}</span>
          <span>OSCAL link · bytes are not embedded</span>
        </article>
      </div>
      <div className="l2-legend" aria-label="Evidence focus legend" data-testid="evidence-legend">
        <span><i className="l2-link" /> evidence link</span>
        <span><span className="l2-odp">‹ parameter ›</span> insert</span>
      </div>
    </div>
  );
}

function FocusProse({
  prose,
  index,
}: {
  prose: string;
  index: Record<string, { label: string; constraint: string | null }>;
}) {
  return (
    <>
      {proseSegments(prose, index).map((segment, indexKey) => {
        if (segment.kind === "text") return <span key={indexKey}>{segment.text}</span>;
        return <Insert key={indexKey} segment={segment} />;
      })}
    </>
  );
}

function Insert({ segment }: { segment: ProseSegment }) {
  const title = segment.kind === "open" ? "organization defined parameter" : segment.text;
  return <span className="l2-odp" title={title}>‹ {segment.text} ›</span>;
}

function rowsFor(pkg: PackageState, evidenceId: string): Row[] {
  const rows: Row[] = [];
  for (const control of pkg.controls) {
    if (!control.evidence.some((item) => item.id === evidenceId)) continue;
    const links = itemEvidenceLinks(control).filter((link) => link.evidenceId === evidenceId);
    const statements = pkg.map.statements[control.id] ?? null;
    const index = statements?.paramIndex ?? {};
    if (links.length === 0) {
      rows.push({
        key: `${control.id}:control`,
        controlId: control.id,
        controlTitle: control.title,
        itemId: null,
        label: control.id,
        labelTitle: control.id,
        prose: "Evidence is linked to the control, not to statement items.",
        index,
      });
      continue;
    }
    for (const link of links) {
      const node = statements ? findStatement(statements.items, link.statementId) : null;
      rows.push({
        key: `${control.id}:${link.statementId}`,
        controlId: control.id,
        controlTitle: control.title,
        itemId: link.statementId,
        label: shortStatementLabel(node?.label ?? null, link.statementId),
        labelTitle: link.statementId,
        prose: node?.prose ?? link.statementId,
        index,
      });
    }
  }
  return rows;
}

function shortStatementLabel(label: string | null, statementId: string): string {
  const raw = (label ?? "").replace(/\.$/, "").trim();
  if (raw && raw.length <= 4 && !raw.includes("_")) return raw;
  if (statementId.endsWith("_smt") || raw.endsWith("_smt")) return "stmt";
  const tail = statementId.split(".").pop() || statementId;
  return tail.length <= 8 ? tail : "stmt";
}

function spread(origin: number, size: number, count: number, index: number): number {
  if (count <= 1) return origin + size / 2;
  const span = size * 0.7;
  const start = origin + (size - span) / 2;
  return start + (span * index) / (count - 1);
}
