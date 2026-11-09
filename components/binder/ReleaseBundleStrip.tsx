"use client";
import React from "react";
import type { ReleaseEvidence } from "@/lib/aegis/release-evidence";

export function ReleaseBundleStrip({bundle, onOpen, loading = false}: {
  bundle?: ReleaseEvidence; onOpen: (id: string) => void; loading?: boolean;
}) {
  if (bundle?.rangeStatus !== "verified") return null;
  const items = bundle.items.filter(item => item.retestResult === "pass");
  if (!items.length) return null;
  return <section className="release-card" aria-label="Verified fixes in this release" data-testid="release-bundle-strip">
    <div className="release-section-title"><h2>Verified fixes <span>{items.length}</span></h2></div>
    <div className="rem-chips">{items.map(item => <button key={item.poamItemId} type="button" className="btn ghost"
      disabled={loading} onClick={() => onOpen(item.poamItemId)} data-poam-item={item.poamItemId}
      title="Collected release retest passed. Human closure review is still required."
      aria-label={item.controlId + " " + item.findingId + " PR #" + item.prNumber + "; open item"}>
      <span className="pill pass">{item.controlId}</span>{" "}
      <code>{item.findingId.slice(-8)}</code>{" "}#{item.prNumber}
    </button>)}</div>
  </section>;
}
