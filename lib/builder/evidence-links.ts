import type {PipelineEvidence} from "../aegis/pipeline-evidence";
import {recordedEvidenceHref} from "../aegis/recorded-evidence";
/** UI inspection links only: canonical receipt/export links retain their original identity. */
export function evidenceViewerHref(href: string | undefined, check?: string, record?: PipelineEvidence): string | undefined {
  if (!href) return href;
  const recorded = record ? recordedEvidenceHref(href, record) : null;
  if (recorded) return recorded;
  try {
    const url = new URL(href, "https://binder.local");
    const match = /^\/api\/builder\/evidence\/([a-f0-9]{64})$/.exec(url.pathname);
    const connection = url.searchParams.get("connection");
    if (!match || !connection || !/^[0-9a-f-]{36}$/.test(connection)) return href;
    const params = new URLSearchParams({ connection });
    const artifact = url.searchParams.get("artifact");
    if (artifact !== null) params.set("artifact", artifact);
    if (check) params.set("check", check);
    return `/evidence/${match[1]}?${params}`;
  } catch { return href; }
}
