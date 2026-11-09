import { createHash } from "node:crypto";

/** RFC 8785 JSON Canonicalization Scheme for the values this reader emits. */
export function canonicalize(value: unknown): string {
  return jcs(value);
}

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Bytes(canonicalize(value));
}

function jcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    return `{${keys.map((key) => {
      if (record[key] === undefined) throw new Error(`Canonical JSON cannot encode undefined at ${key}.`);
      return `${JSON.stringify(key)}:${jcs(record[key])}`;
    }).join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`);
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
