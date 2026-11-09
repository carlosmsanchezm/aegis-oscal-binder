import { DOT, ELLIPSIS } from "./copy";

const HEX = /^[0-9a-f]{64}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fullDigest(value: string | null | undefined): string | null {
  const digest = (value ?? "").trim().toLowerCase();
  return HEX.test(digest) ? digest : null;
}

/** Receipt form, as drawn: first 20 characters, an ellipsis, last 7. */
export function receiptDigest(value: string | null | undefined): string {
  const digest = fullDigest(value);
  return digest ? `${digest.slice(0, 20)}${ELLIPSIS}${digest.slice(-7)}` : "";
}

/** Short form, as drawn: first 8 characters, an ellipsis, last 7. */
export function shortDigest(value: string | null | undefined): string {
  const digest = fullDigest(value);
  return digest ? `${digest.slice(0, 8)}${ELLIPSIS}${digest.slice(-7)}` : "";
}

/** Export form, as drawn in frames 13 and 25: the first 6 characters. */
export function exportDigest(value: string | null | undefined): string {
  const digest = fullDigest(value);
  return digest ? digest.slice(0, 6) : "";
}

type Parts = { hh: string; mm: string; ss: string; month: string; day: number };

function parts(value: string | null | undefined): Parts | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const two = (n: number) => String(n).padStart(2, "0");
  return {
    hh: two(date.getUTCHours()),
    mm: two(date.getUTCMinutes()),
    ss: two(date.getUTCSeconds()),
    month: MONTHS[date.getUTCMonth()] as string,
    day: date.getUTCDate(),
  };
}

/** "18:39:19 UTC \u00b7 Oct 6" (frame 22 and 23 store times). */
export function storedTime(value: string | null | undefined): string | null {
  const p = parts(value);
  return p ? `${p.hh}:${p.mm}:${p.ss} UTC ${DOT} ${p.month} ${p.day}` : null;
}

/** "14:36, 15 Oct" (export rows). */
export function exportTime(value: string | null | undefined): string | null {
  const p = parts(value);
  return p ? `${p.hh}:${p.mm}, ${p.day} ${p.month}` : null;
}

/** "14:40 UTC \u00b7 15 Oct" (last check). */
export function checkTime(value: string | null | undefined): string | null {
  const p = parts(value);
  return p ? `${p.hh}:${p.mm} UTC ${DOT} ${p.day} ${p.month}` : null;
}

/** "18:39:19 \u00b7 Oct 6" with seconds, or "14:12 \u00b7 Oct 15" without (audit UTC column). */
export function auditTime(value: string | null | undefined, seconds = false): string | null {
  const p = parts(value);
  if (!p) return null;
  return `${p.hh}:${p.mm}${seconds ? `:${p.ss}` : ""} ${DOT} ${p.month} ${p.day}`;
}

/** "14:40 UTC \u00b7 Oct 15" (selected audit entry). */
export function entryTime(value: string | null | undefined): string | null {
  const p = parts(value);
  return p ? `${p.hh}:${p.mm} UTC ${DOT} ${p.month} ${p.day}` : null;
}

/** "02:54:20 UTC \u00b7 Oct 6, 2026" (frame 19 observed and received). */
export function fullTime(value: string | null | undefined): string | null {
  const p = parts(value);
  return p ? `${p.hh}:${p.mm}:${p.ss} UTC ${DOT} ${p.month} ${p.day}, ${new Date(value as string).getUTCFullYear()}` : null;
}

/** "03:54:20 UTC" (frame 19 received after expiry hint). */
export function clockTime(value: string | null | undefined): string | null {
  const p = parts(value);
  return p ? `${p.hh}:${p.mm}:${p.ss} UTC` : null;
}

/** "03:54:20 UTC, Oct 6" (frame 19 expired banner). */
export function expiredTime(value: string | null | undefined): string | null {
  const p = parts(value);
  return p ? `${p.hh}:${p.mm}:${p.ss} UTC, ${p.month} ${p.day}` : null;
}

/** Release id as drawn beside an observation: the first 32 receipt characters, shown as first 8 and last 5. */
export function releaseLabel(receipt: string): string {
  const digest = fullDigest(receipt);
  return digest ? `#${digest.slice(0, 8)}${ELLIPSIS}${digest.slice(27, 32)}` : "";
}

/** Revision as drawn: a long commit shortened to 12 characters, any suffix kept. */
export function revisionLabel(revision: string): string {
  const match = /^([0-9a-f]{13,64})(:.*)?$/.exec(revision);
  return match ? `${(match[1] as string).slice(0, 12)}${ELLIPSIS}${match[2] ?? ""}` : revision;
}

/** Stored export file name without its export id prefix, as frames 13 and 25 draw it.
 * Word and Excel bytes are stored as package.docx and package.xlsx. Those frames label the same files ssp-readable.docx and control-table.xlsx. */
export function exportFileLabel(objectName: string, exportId: string | null): string {
  const bare = exportId && objectName.startsWith(`${exportId}-`) ? objectName.slice(exportId.length + 1) : objectName;
  const render = /^(?:package)(\.v\d+)?\.(docx|xlsx)$/.exec(bare);
  if (!render) return bare;
  const stem = render[2] === "docx" ? "ssp-readable" : "control-table";
  return `${stem}${render[1] ?? ""}.${render[2]}`;
}

/** Format pill drawn before export file names. */
export function formatPill(role: string): string {
  if (role === "word") return "DOCX";
  if (role === "excel") return "XLSX";
  return "XML";
}
