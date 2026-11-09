import type { Provider, Role } from "./types";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 200 || !EMAIL.test(email)) return null;
  return email;
}

export function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > max || CONTROL.test(name)) return null;
  return name;
}

export function initials(name: string, email = ""): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : (parts[0] ?? "").slice(0, 2))
    || email.slice(0, 2);
  const cleaned = letters.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 2) || "MB";
}

export function roleLabel(role: Role): string {
  switch (role) {
    case "admin": return "Admin";
    case "isso": return "ISSO";
    case "system-owner": return "System owner";
    case "engineer": return "Engineer";
    case "assessor": return "Assessor";
    case "viewer": return "Viewer";
    case "isse": return "ISSE";
    case "release-manager": return "Release manager";
    default: {
      const exhaustive: never = role;
      return exhaustive;
    }
  }
}

export function providerLabel(provider: Provider): string {
  return provider === "google" ? "Google" : "Microsoft";
}

export function lastActiveLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 2) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Relative path only. Rejects scheme-relative and backslash redirects. */
export function safeReturn(value: unknown, fallback = "/account"): string {
  if (typeof value !== "string") return fallback;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("\0") || path.length > 300) return fallback;
  if (/[\u0000-\u001f]/.test(path)) return fallback;
  return path;
}
