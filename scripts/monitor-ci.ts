import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canonicalCapture } from "../lib/monitoring/capture";
import type { ScanTrigger, SourceCaptureDocument } from "../lib/monitoring/types";

const HELP = `aegis monitor ci

  AEGIS_BUILDER_TOKEN=... npx tsx scripts/monitor-ci.ts --sources sources.json --out evidence-output --endpoint https://host/api/monitoring/connections/ID/captures
  AEGIS_BUILDER_TOKEN=... npx tsx scripts/monitor-ci.ts --capture evidence-output/capture.json --endpoint https://host/api/monitoring/connections/ID/captures

The token is read from the environment and sent only as an Authorization header.
`;

type Opts = { sources?: string; out?: string; capture?: string; endpoint?: string; runId?: string; help: boolean };

function parse(argv: string[]): Opts {
  const opts: Opts = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (arg === "--sources" || arg === "--out" || arg === "--capture" || arg === "--endpoint" || arg === "--run-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      const key = arg === "--run-id" ? "runId" : arg.slice(2) as "sources" | "out" | "capture" | "endpoint";
      opts[key] = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option ${arg}`);
  }
  return opts;
}

function endpointAllowed(value: string): boolean {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("Invalid upload endpoint.");
  return true;
}

async function upload(endpoint: string, token: string, trigger: ScanTrigger, capture: SourceCaptureDocument): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ adapter: "repo-scanner", trigger, capture }),
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upload failed with HTTP ${response.status}. ${text.slice(0, 300).replace(token, "")}`);
  process.stdout.write(`${text}\n`);
}

try {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); process.exit(0); }
  if (!opts.endpoint || (!opts.capture && !(opts.sources && opts.out))) throw new Error("Pass --endpoint and either --capture or --sources with --out.");
  endpointAllowed(opts.endpoint);
  const token = process.env.AEGIS_BUILDER_TOKEN ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("AEGIS_BUILDER_TOKEN is not set.");
  let file = opts.capture;
  if (opts.sources) {
    if (!opts.out) throw new Error("Pass --out with --sources.");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/collect-evidence.ts", opts.sources, opts.out], { stdio: "inherit" });
    file = `${opts.out.replace(/\/$/, "")}/capture.json`;
  }
  const document = canonicalCapture(JSON.parse(readFileSync(file!, "utf8")));
  const runId = opts.runId ?? process.env.GITHUB_RUN_ID ?? "local";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) throw new Error("Invalid run id.");
  for (const capture of document.captures) {
    const trigger: ScanTrigger = { kind: "ci", repo: capture.source.repo, revision: capture.source.commit, at: capture.source.capturedAt, runId };
    await upload(opts.endpoint, token, trigger, { schema: "aegis.source-capture.v1", captures: [capture] });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Monitor upload failed.";
  process.stderr.write(`${message.replace(process.env.AEGIS_BUILDER_TOKEN ?? "\u0000", "")}\n`);
  process.exit(message.startsWith("Unknown option") || message.startsWith("Pass ") || message.startsWith("Missing value") ? 2 : 1);
}
