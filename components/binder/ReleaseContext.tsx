"use client";

import {releaseSystemName} from "@/lib/aegis/rollup-package";
import type { PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { utcTime } from "@/lib/builder/presentation";
import { freshnessLabel } from "@/lib/builder/evidence";
import React, { type ReactNode } from "react";

export function ReleaseContext({ record, onOpen, children, selected = true }: { selected?: boolean; record: PipelineEvidence; onOpen?: () => void; children?: ReactNode }) {
  return <section className="release-context" aria-label="Current release">
    <span className="release-dot" aria-hidden="true" /><strong>{releaseSystemName([record])}</strong>
    {selected ? <><b title={record.releaseSha256}>#{record.pipelineId}</b><code title={record.commitSha}>{record.commitSha.slice(0, 12)}</code>
    <span>snapshot · {utcTime(record.createdAt)}</span>
    <span className="release-policy">{record.schema === "aegis.evidence-event.v1" ? `Captured ${record.observation.reportedOutcome.toUpperCase()}` : `Policy ${record.policyVerdict.toUpperCase()}`}</span>
    {record.schema === "aegis.evidence-event.v1" && <span className="release-freshness">Evidence {[...new Set(record.checks.map(c => freshnessLabel(c.status)))].join(", ")}</span>}
    <span className="release-review">Review open · {record.gaps.length + (record.reviewItems?.length??0)}</span></> : <span>No release selected · workspace data below is unchanged</span>}
    {onOpen && <button type="button" onClick={onOpen}>Release evidence →</button>}
    {children}
  </section>;
}
