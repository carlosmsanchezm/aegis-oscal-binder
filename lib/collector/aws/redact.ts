const SECRET = /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secretAccessKey|sessionToken|aws_secret_access_key|aws_session_token)\s*[:=]\s*\S+/gi;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

export function redactText(value: string): string {
  return value.replace(SECRET, "[redacted]").replace(TIMESTAMP, "[time]");
}

export function cleanDetail(value: string): string {
  return redactText(value).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 180);
}

export function assertNoSecrets(text: string, label: string): void {
  SECRET.lastIndex = 0;
  if (SECRET.test(text)) {
    throw new Error(`${label} contains a secret pattern and was not written.`);
  }
}
