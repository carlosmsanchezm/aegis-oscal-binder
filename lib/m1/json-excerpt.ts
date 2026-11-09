import { EXPAND } from "./copy";

/** Objects and arrays this deep start folded, as the locked excerpt folds f:resourceAttributes. */
export const FOLD_DEPTH = 6;

export type ExcerptToken =
  | { kind: "text"; text: string }
  | { kind: "key"; text: string }
  | { kind: "string"; text: string }
  | { kind: "literal"; text: string }
  | { kind: "fold"; text: string; path: string; count: number };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isContainer(value: Json): value is Json[] | { [key: string]: Json } {
  return value !== null && typeof value === "object";
}

function size(value: Json[] | { [key: string]: Json }): number {
  return Array.isArray(value) ? value.length : Object.keys(value).length;
}

function folded(value: Json, depth: number, path: string, expanded: ReadonlySet<string>): boolean {
  return isContainer(value) && size(value) > 0 && depth >= FOLD_DEPTH && !expanded.has(path);
}

/** A single key chain that ends in a folded value prints on one line. */
function inline(value: Json, depth: number, path: string, expanded: ReadonlySet<string>): boolean {
  if (!isContainer(value) || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0] as string;
  const child = value[key] as Json;
  const childPath = `${path}/${key}`;
  return folded(child, depth + 1, childPath, expanded) || inline(child, depth + 1, childPath, expanded);
}

export function excerptTokens(value: unknown, expanded: ReadonlySet<string> = new Set()): ExcerptToken[] {
  const out: ExcerptToken[] = [];
  const text = (t: string) => out.push({ kind: "text", text: t });
  const walk = (node: Json, depth: number, path: string, indent: string) => {
    if (!isContainer(node)) {
      if (typeof node === "string") out.push({ kind: "string", text: JSON.stringify(node) });
      else out.push({ kind: "literal", text: JSON.stringify(node) });
      return;
    }
    const array = Array.isArray(node);
    const entries: Array<[string, Json]> = array ? node.map((item, index) => [String(index), item]) : Object.entries(node);
    if (entries.length === 0) return text(array ? "[]" : "{}");
    if (folded(node, depth, path, expanded)) {
      const count = entries.length;
      out.push({ kind: "fold", path, count, text: array ? `${EXPAND} [ ${count} item${count === 1 ? "" : "s"} ]` : `${EXPAND} { ${count} field${count === 1 ? "" : "s"} }` });
      return;
    }
    if (inline(node, depth, path, expanded)) {
      const [key, child] = entries[0] as [string, Json];
      text("{ ");
      out.push({ kind: "key", text: JSON.stringify(key) });
      text(": ");
      walk(child, depth + 1, `${path}/${key}`, indent);
      text(" }");
      return;
    }
    const inner = `${indent}  `;
    text(array ? "[\n" : "{\n");
    entries.forEach(([key, child], index) => {
      text(inner);
      if (!array) {
        out.push({ kind: "key", text: JSON.stringify(key) });
        text(": ");
      }
      walk(child, depth + 1, `${path}/${key}`, inner);
      text(index < entries.length - 1 ? ",\n" : "\n");
    });
    text(`${indent}${array ? "]" : "}"}`);
  };
  walk(value as Json, 0, "", "");
  const merged: ExcerptToken[] = [];
  for (const token of out) {
    const last = merged[merged.length - 1];
    if (token.kind === "text" && last?.kind === "text") last.text += token.text;
    else merged.push({ ...token });
  }
  return merged;
}

export function excerptText(tokens: ExcerptToken[]): string {
  return tokens.map((token) => token.text).join("");
}

/** The measured boolean a SelfSubjectAccessReview carries, when present. */
export function measuredAllowed(value: unknown): boolean | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  if (!status || typeof status !== "object") return null;
  const allowed = (status as { allowed?: unknown }).allowed;
  return typeof allowed === "boolean" ? allowed : null;
}
