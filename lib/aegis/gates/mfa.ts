/** Step-up check. The proof is a timestamp for a subject. It is not a factor secret. */
export type MfaProof = {
  subjectId: string;
  verifiedAt: string;
};

export type MfaCheck = {
  fresh: boolean;
  ageMs: number | null;
  reason: "fresh" | "missing" | "stale" | "subject" | "skew" | "unreadable";
};

export type MfaChecker = (input: { actorId: string; proof: MfaProof | null; now: string; maxAgeMs: number }) => MfaCheck;

/** Privileged gate decisions require a fresh step-up within this window. */
export const DEFAULT_MFA_MAX_AGE_MS = 15 * 60 * 1000;
const SKEW_MS = 60 * 1000;

export function defaultMfaChecker(input: { actorId: string; proof: MfaProof | null; now: string; maxAgeMs: number }): MfaCheck {
  if (!input.proof) return { fresh: false, ageMs: null, reason: "missing" };
  if (input.proof.subjectId !== input.actorId) return { fresh: false, ageMs: null, reason: "subject" };
  const verified = Date.parse(input.proof.verifiedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(verified) || !Number.isFinite(now)) return { fresh: false, ageMs: null, reason: "unreadable" };
  const age = now - verified;
  if (age < -SKEW_MS) return { fresh: false, ageMs: age, reason: "skew" };
  if (age > input.maxAgeMs) return { fresh: false, ageMs: age, reason: "stale" };
  return { fresh: true, ageMs: age, reason: "fresh" };
}
