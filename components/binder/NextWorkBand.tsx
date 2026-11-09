"use client";
import {nextWorkModel} from "@/lib/aegis/map-next-work";
import type {PackageState} from "@/lib/aegis/types";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

type Item = {
  id: string;
  controlId: string;
  kind: string;
  riskReason: string;
  relevanceReason: string;
  costReason: string;
};
export function NextWorkBand({
  items:rawItems, ownerPackage,
  hasHistory,
  proposalCounts,
  hasPlan,
  onOpen,
}: {
  items: Item[];
  ownerPackage?:PackageState;
  hasHistory: boolean;
  proposalCounts?: ReadonlyMap<string, number>;
  hasPlan: (id: string) => boolean;
  onOpen: (item: Item) => void;
}) {
  const items=nextWorkModel(rawItems,proposalCounts,ownerPackage);
  const findingDestinations=[...new Set(items.filter(item=>item.kind==="open-finding").map(item=>hasPlan(item.controlId)?"plan of action":"Level 2"))];
  const [open, setOpen] = useState(false),
    [visible, setVisible] = useState(3);
  const ref = useRef<HTMLElement>(null),
    button = useRef<HTMLButtonElement>(null),
    row = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const node = row.current;
    if (!node) return;
    const size = () => {
      let used = 0,
        count = 0;
      for (const child of node.children) {
        used += (child as HTMLElement).offsetWidth + 8;
        if (used > node.clientWidth) break;
        count++;
      }
      setVisible(Math.max(1, count));
    };
    const observer = new ResizeObserver(size);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    size();
    return () => observer.disconnect();
  }, [items.length]);
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      button.current?.focus();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  function chip(item: Item & {owner?:string}, index: number, queue = false) {
    const suggested =
      item.kind === "blank" && (proposalCounts?.get(item.controlId) ?? 0) > 0;
    const finding = item.kind === "open-finding";
    const kind = finding ? "open-finding" : suggested ? "proposals" : "blank";
    const dest =
      finding && hasPlan(item.controlId)
        ? "plan of action"
        : suggested
          ? "its card on the map"
          : "Level 2";
    const label = finding ? "Finding" : suggested ? "Suggested" : "Blank";
    return (
      <li
        key={item.id}
        data-overflow={!queue && index >= visible ? "true" : undefined}
        data-kind={kind}
      >
        <button
          type="button"
          className="map-next-chip"
          data-kind={kind}
          data-primary={index === 0 ? "true" : undefined}
          data-hint={`${suggested ? "Suggested evidence to review." : finding ? "Open finding." : "No evidence linked yet."} Opens ${dest}.`}
          aria-label={`${index+1} ${item.controlId}${item.owner?` Owner ${item.owner}`:""} ${label} opens ${dest}`}
          title={`${item.controlId} · ${label} · opens ${dest}`}
          aria-description={`${item.riskReason} ${item.relevanceReason} ${item.costReason}`}
          onClick={() => {
            setOpen(false);
            onOpen(item);
          }}
        >
          <span className="map-next-rank">{index + 1}</span>
          <i className="map-next-dot" aria-hidden="true" />
          <strong>{item.controlId}</strong>
          {item.owner&&<em className="map-next-owner">{item.owner}</em>}
          <span className="sr-only">{label} · opens {dest}</span>
        </button>
      </li>
    );
  }
  return (
    <section
      ref={ref}
      className="release-card map-next-work"
      data-testid="map-next-work"
    >
      <h2>Next work</h2>
      {!hasHistory ? (
        <p>No pipeline evidence selected.</p>
      ) : (
        <>
          <ol className="map-next-band" ref={row}>
            {items.map((item, index) => chip(item, index))}
          </ol>
          <div className="map-next-legend" aria-label="Next work legend"><span data-kind="open-finding"><i/>Finding → {findingDestinations.join(" or ")||"plan of action"}</span><span data-kind="proposals"><i/>Suggested files → control on map</span></div>
          {items.length > visible && (
            <button
              ref={button}
              type="button"
              className="text-btn map-full-queue"
              aria-expanded={open}
              aria-controls="map-ranked-queue"
              onClick={() => setOpen(!open)}
            >
              Full queue ▾
            </button>
          )}
          {open && (
            <div id="map-ranked-queue" className="map-ranked-queue">
              <h3>Ranked queue · {items.length}</h3>
              <ol>{items.map((item, index) => chip(item, index, true))}</ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}
