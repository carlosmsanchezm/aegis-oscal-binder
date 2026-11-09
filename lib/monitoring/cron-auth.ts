import { createHash, timingSafeEqual } from "node:crypto";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Missing or wrong secrets fail closed. */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  const presented = /^Bearer\s+(\S+)$/.exec(header ?? "")?.[1];
  if (!secret || !presented) return false;
  const a = createHash("sha256").update(secret).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}
