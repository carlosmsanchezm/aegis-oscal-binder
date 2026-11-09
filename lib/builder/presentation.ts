/** Stable UTC presentation keeps captured and received times distinct. */
export function utcTime(value: string, precise = false): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", ...(precise ? { second: "2-digit" as const, fractionalSecondDigits: 3 as const } : {}), day: "numeric", month: "short" }).format(date) + " UTC" : value;
}
export function receiptLabel(value: string): string { return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value; }

/** One count formatter for shared UI copy; explicit plural supports irregular nouns. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string { return `${count} ${count === 1 ? singular : plural}`; }

/** Keep transport failures actionable without exposing browser error jargon. */
export function requestMessage(error: unknown, fallback: string): string {
  const message=error instanceof Error ? error.message : fallback;
  return /failed to fetch|load failed|networkerror|network request failed/i.test(message)
    ? "Connection paused. Retry this action to reconnect; your last saved decisions are unchanged."
    : message;
}
