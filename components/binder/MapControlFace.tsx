"use client";
import React, { memo } from "react";
import type { statementCoverage } from "@/lib/aegis/map-view";

type Props = {
  untouched?:boolean;
  id: string;
  a: string;
  b: string;
  proposalPill: boolean;
  coverage: ReturnType<typeof statementCoverage>;
  selectedDot: string | null;
  linked: boolean;
  reviewText: string | null;
  reviewTitle: string;
  reviewState: "closed" | "open";
  statusClass: string;
  statusText: string;
  statusTitle: string | undefined;
  proposalFont: number;
};

/** Scroll/selection chrome can update without rebuilding every unchanged statement marker. */
export const MapControlFace = memo(function MapControlFace({
  id, untouched=false,
  a,
  b,
  proposalPill,
  coverage,
  selectedDot,
  linked,
  reviewText,
  reviewTitle,
  reviewState,
  statusClass,
  statusText,
  statusTitle,
  proposalFont,
}: Props) {
  if(untouched)return <span className="mono cid">{id}</span>;
  const addressed = coverage.filter((item) => item.state !== "empty").length;
  const noEvidence = coverage.filter(
    (item) => item.state === "addressed",
  ).length;
  return (
    <>
      <span className="mono cid">{id}</span>
      <span className="t1">{a}</span>
      <span className="t2">{b}</span>
      {!proposalPill && (
        <span
          className="pmap-coverage-ticks"
          aria-label={`${addressed} of ${coverage.length} statement items addressed; ${noEvidence} without item-level evidence`}
        >
          {coverage.map((item) => (
            <i
              key={item.id}
              data-control-dot={item.id}
              data-selected-dot={
                selectedDot === `${id}:${item.id}` ? "true" : undefined
              }
              className={item.state}
              title={`${item.id}: ${item.state === "linked" ? "addressed with evidence" : item.state === "addressed" ? "addressed, no item-level evidence" : "not addressed"}`}
            />
          ))}
        </span>
      )}
      {linked && <span className="round21-linked-badge">● linked</span>}
      {!proposalPill && reviewText && (
        <span
          className="pmap-review-state"
          title={reviewTitle}
          data-plan-state={reviewState}
        >
          {reviewText}
        </span>
      )}
      <span
        style={proposalPill ? { fontSize: proposalFont } : undefined}
        className={statusClass}
        title={statusTitle}
      >
        {statusText}
      </span>
    </>
  );
});
