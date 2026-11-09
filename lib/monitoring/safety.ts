const SECRET = /bearer\s+[a-z0-9._~+/-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-|ASIA[0-9A-Z]{16}/i;

/** Refuse records that already contain a credential. Does not rewrite the value. */
export function assertNoSecrets(body: string): void {
  if (SECRET.test(body)) throw new Error("Refusing to retain a secret value.");
}

export function canonicalRepo(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Invalid source URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid source URL.");
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function canonicalSourceId(value: string): string {
  if (value.startsWith("https://")) return canonicalRepo(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/.test(value)) throw new Error("Invalid source id.");
  return value;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function canonicalTimestamp(value: string): string {
  if (!ISO.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid capture time.");
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("Invalid capture time.");
  return value;
}
