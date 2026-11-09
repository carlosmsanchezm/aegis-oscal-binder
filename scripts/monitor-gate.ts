import { readFileSync } from "node:fs";
import { canonicalCapture, captureArtifacts } from "../lib/monitoring/capture";
import { classifyDrift } from "../lib/monitoring/drift";
import { evaluateGate, parseAllowlist, type GateMode } from "../lib/monitoring/gate";

type Opts = { capture?: string; baseline?: string; allow?: string; enforce: boolean; help: boolean };

function parse(argv: string[]): Opts {
  const opts: Opts = { enforce: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (arg === "--enforce") { opts.enforce = true; continue; }
    if (arg === "--capture" || arg === "--baseline" || arg === "--allow") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      opts[arg.slice(2) as "capture" | "baseline" | "allow"] = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option ${arg}`);
  }
  return opts;
}

const HELP = `aegis monitor gate

  npx tsx scripts/monitor-gate.ts --capture new.json --baseline previous.json
  npx tsx scripts/monitor-gate.ts --capture new.json --baseline previous.json --allow CM-6,KSI-IAM
  npx tsx scripts/monitor-gate.ts --capture new.json --baseline previous.json --enforce

Report-only is the default and exits 0. --enforce exits 1 when a passing
control or KSI would become a fail and is not in the allowlist.
`;

function readCapture(file: string) {
  return captureArtifacts(canonicalCapture(JSON.parse(readFileSync(file, "utf8"))));
}

try {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); process.exit(0); }
  if (!opts.capture || !opts.baseline) throw new Error("Pass --capture and --baseline.");
  const mode: GateMode = opts.enforce ? "enforce" : "report";
  const report = evaluateGate(classifyDrift(readCapture(opts.baseline), readCapture(opts.capture)), parseAllowlist(opts.allow), mode);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : "Invalid gate input.";
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
