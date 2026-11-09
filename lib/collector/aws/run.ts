import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  GOVCLOUD_TARGET, accountTarget, assertTargetCaller, type AccountTarget,
  PROWLER_FRAMEWORK,
  PROWLER_VERSION,
  type CallerIdentity,
  stsEndpoint,
} from "./account";
import { ingestProwler, type IngestedScan } from "./ingest";
import { recordBytes, scanFilename, type ScanTrigger } from "./scan-record";

export class UsageError extends Error {}

export type CommandRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => string;

type ScanOptions = {
  target?: AccountTarget;
  fixture?: string;
  profile?: string;
  requiredRoleArn?: string;
  regions: string[];
  out?: string;
  help?: boolean;
};

const HELP = `aegis-oscal aws-scan — read-only partition-scoped evidence collector

  pnpm exec tsx scripts/collect-aws.ts --fixture fixtures/aws/empty-account --out out/aws-reader
  pnpm exec tsx scripts/collect-aws.ts --profile aegis-gov-reader --regions us-gov-west-1,us-gov-east-1 --out out/aws-reader
  Optional live guard: --reader-role-arn <exact IAM reader role ARN>

The live command needs Prowler ${PROWLER_VERSION} on PATH and an AWS CLI named profile.
It calls sts:GetCallerIdentity, then Prowler. It does not call AWS write APIs.
Static access keys in the environment are refused. Default: existing GovCloud account guard.
Commercial: --target-file <private JSON> with partition, allowedAccountIds and regions; explicit caller guard.
`;

export function stsCommand(profile?: string, target: AccountTarget = GOVCLOUD_TARGET): { file: string; args: string[] } {
  const region = accountTarget(target).regions[0];
  const endpoint = target.partition === "aws-us-gov" ? stsEndpoint(region) : `https://sts.${region}.amazonaws.com`;
  const args = ["sts", "get-caller-identity", "--region", region, "--endpoint-url", endpoint, "--output", "json"];
  if (profile) args.push("--profile", profile);
  return { file: "aws", args };
}

export function prowlerCommand(options: { profile?: string; regions: string[]; outDir: string; target?: AccountTarget }): { file: string; args: string[]; env: Record<string, string> } {
  const target = accountTarget(options.target ?? GOVCLOUD_TARGET);
  for (const region of options.regions) if (!target.regions.includes(region)) throw new Error("Region outside target.");
  const args = ["aws", "--compliance", PROWLER_FRAMEWORK, "--filter-region", ...options.regions, "-M", "json-ocsf", "--output-directory", options.outDir, "--no-banner"];
  if (options.profile) args.splice(1, 0, "--profile", options.profile);
  if (args.some((arg) => /^(?:fixer|remediat|delete|create|put|update)(?:-|$)/i.test(arg.replace(/^-+/, "")))) {
    throw new Error("Prowler arguments include a write flag.");
  }
  return {
    file: "prowler",
    args,
    env: {
      AWS_USE_FIPS_ENDPOINT: target.partition === "aws-us-gov" ? "true" : "false",
      AWS_DEFAULT_REGION: target.regions[0],
      AWS_REGION: target.regions[0],
      AWS_STS_REGIONAL_ENDPOINTS: "regional",
      PROWLER_AWS_PARTITION: target.partition,
    },
  };
}

export function assertNoStaticKeys(env?: { AWS_ACCESS_KEY_ID?: string; AWS_SECRET_ACCESS_KEY?: string; AWS_SESSION_TOKEN?: string }): void {
  const source = env ?? process.env;
  if (source.AWS_ACCESS_KEY_ID || source.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Refusing static AWS access keys. Use a partition-scoped SSO profile.");
  }
}

/** A requested role must be the actual STS caller before any scanner executes. */
export function assertReaderRole(caller: CallerIdentity, roleArn: string, target: AccountTarget): void {
  assertTargetCaller(caller, target);
  const prefix = `arn:${target.partition}:iam::${caller.Account}:role/`;
  if (!roleArn.startsWith(prefix) || !/^[A-Za-z0-9+=,.@_/-]+$/.test(roleArn.slice(prefix.length)))
    throw new Error("Reader role is outside the target account or partition.");
  const name = roleArn.split("/").at(-1)!;
  const sessionPrefix = `arn:${target.partition}:sts::${caller.Account}:assumed-role/${name}/`;
  if (!name || !caller.Arn.startsWith(sessionPrefix) || !/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(caller.Arn.slice(sessionPrefix.length)))
    throw new Error("Refusing scan: STS caller is not the required reader role.");
}

export function runAwsScan(argv: string[], runner: CommandRunner = defaultRunner): number {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (!options.out) throw new UsageError("Pass --out <directory>.");
    const gitCommit = readGitCommit();
    const capturedAt = new Date().toISOString();
    const ingested = options.fixture
      ? scanFixture(options.fixture, gitCommit, capturedAt, new Date(capturedAt), options.target)
      : scanLive(options, runner, gitCommit, capturedAt);
    const recordPath = writeScan(options.out, ingested);
    const summary = ingested.record.summary;
    process.stdout.write(`${recordPath}\n`);
    process.stdout.write(`account ${ingested.record.target.account_id} partition ${ingested.record.target.partition}\n`);
    process.stdout.write(`summary pass=${summary.pass} fail=${summary.fail} not_applicable=${summary.not_applicable} error=${summary.error} manual=${summary.manual}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "AWS scan failed."}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

export function scanFixture(fixtureDir: string, gitCommit: string, capturedAt: string, now = new Date(capturedAt), target: AccountTarget = GOVCLOUD_TARGET): IngestedScan {
  const caller = JSON.parse(readFileSync(path.join(fixtureDir, "caller.json"), "utf8")) as CallerIdentity;
  const findings = JSON.parse(readFileSync(path.join(fixtureDir, "prowler.ocsf.json"), "utf8")) as unknown;
  assertTargetCaller(caller, target);
  return ingestProwler({ target, findings, caller, capturedAt, trigger: "fixture", now, gitCommit });
}

function scanLive(options: ScanOptions, runner: CommandRunner, gitCommit: string, capturedAt: string): IngestedScan {
  assertNoStaticKeys();
  if (!options.profile && process.env.GITHUB_ACTIONS !== "true") {
    throw new UsageError("Pass a partition-scoped --profile, or run with --fixture.");
  }
  const trigger: ScanTrigger = options.profile ? "local-profile" : "github-oidc";
  const target = accountTarget(options.target ?? GOVCLOUD_TARGET);
  const sts = stsCommand(options.profile, target);
  process.stderr.write("sts:GetCallerIdentity\n");
  const caller = JSON.parse(runner(sts.file, sts.args, liveEnv())) as CallerIdentity;
  assertTargetCaller(caller, target);
  if (options.requiredRoleArn) assertReaderRole(caller, options.requiredRoleArn, target);
  const version = runner("prowler", ["--version"], liveEnv());
  if (!new RegExp(`(?:^|[^\\d.])${PROWLER_VERSION.replace(/\./g, "\\.")}(?:[^\\d.]|$)`).test(version)) {
    throw new Error(`Prowler ${PROWLER_VERSION} is required. The installed version did not match.`);
  }
  const outDir = path.join(options.out ?? "", ".prowler");
  mkdirSync(outDir, { recursive: true });
  const prowler = prowlerCommand({ profile: options.profile, regions: options.regions, outDir, target });
  process.stderr.write(`prowler:${PROWLER_FRAMEWORK}\n`);
  runner(prowler.file, prowler.args, { ...liveEnv(), ...prowler.env });
  const findings = JSON.parse(readFileSync(findOcsf(outDir), "utf8")) as unknown;
  const finishedAt = new Date();
  return ingestProwler({ target, findings, caller, capturedAt: finishedAt.toISOString(), trigger, now: new Date(capturedAt), finishedAt, gitCommit });
}

/** Internal connected collector entry. It always executes STS and pinned Prowler;
 * caller-supplied report bytes and fixture options are not accepted. */
export function collectLiveAws(options:{target:AccountTarget;profile:string;out:string;requiredRoleArn:string}):IngestedScan {
  if (!options.requiredRoleArn) throw new Error("Connected AWS collection requires a reader role.");
  const target=accountTarget(options.target);
  const scan=scanLive({...options,regions:[...target.regions]},defaultRunner,readGitCommit(),new Date().toISOString());
  writeScan(options.out,scan);
  return scan;
}

export function writeScan(outDir: string, ingested: IngestedScan): string {
  mkdirSync(outDir, { recursive: true });
  const fileName = scanFilename(ingested.record.run.finished_utc, ingested.record.integrity.sha256);
  const recordPath = path.join(outDir, fileName);
  writeFileSync(recordPath, recordBytes(ingested.record), { flag: "wx" });
  for (const event of ingested.events) {
    writeFileSync(path.join(outDir, `event-${event.id}.json`), event.rawEvent, { flag: "wx" });
  }
  return recordPath;
}

function findOcsf(dir: string): string {
  const matches = readdirSync(dir).filter((name) => name.endsWith(".ocsf.json")).sort();
  if (matches.length !== 1) throw new Error("Prowler did not write exactly one .ocsf.json report.");
  return path.join(dir, matches[0]);
}

function liveEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  return env;
}

function defaultRunner(file: string, args: string[], env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(file, args, { encoding: "utf8", env });
  } catch (error) {
    // Prowler 5.45.0 returns 3 for completed scans with failed findings.
    // Preserve those failures in the seal; report parsing/guards still apply.
    const result = error as { status?: number; signal?: string | null; stdout?: string };
    if (file === "prowler" && args[0] === "aws" && result.status === 3 && !result.signal)
      return typeof result.stdout === "string" ? result.stdout : "";
    throw error;
  }
}

function readGitCommit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  } catch { /* fixture runs can still pass an explicit commit through ingest */ }
  return "0".repeat(40);
}

function parseArgs(argv: string[]): ScanOptions {
  const configIndex = argv.indexOf("--target-file");
  if(configIndex >= 0){
    const file=argv[configIndex+1];if(!file||file.startsWith("--"))throw new UsageError("Pass --target-file <private config file>.");
    const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new UsageError("Target config must be a mode-0600 regular file outside Git.");
  }
  const target = configIndex < 0 ? GOVCLOUD_TARGET : accountTarget(JSON.parse(readFileSync(argv[configIndex + 1], "utf8")));
  const options: ScanOptions = { target, regions: [...target.regions] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--target-file") { i += 1; continue; }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--fixture" || arg === "--profile" || arg === "--reader-role-arn" || arg === "--regions" || arg === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      if (arg === "--fixture") options.fixture = value;
      if (arg === "--reader-role-arn") options.requiredRoleArn = value;
      if (arg === "--profile") {
        if (!/^[A-Za-z0-9+=,._@-]{1,64}$/.test(value)) throw new UsageError("Profile name is not accepted.");
        options.profile = value;
      }
      if (arg === "--out") options.out = value;
      if (arg === "--regions") {
        const regions = value.split(",").filter(Boolean);
        if (regions.length === 0) throw new UsageError("Pass at least one region.");
        for (const region of regions) {
          try { if (!target.regions.includes(region)) throw new Error("Region outside configured target."); }
          catch (error) { throw new UsageError(error instanceof Error ? error.message : "Invalid region."); }
        }
        options.regions = regions;
        options.target = {...target, regions};
      }
      continue;
    }
    throw new UsageError(`Unknown option ${arg}.`);
  }
  if (!options.help && options.fixture && options.profile) throw new UsageError("Pass either --fixture or --profile.");
  if (options.fixture && options.requiredRoleArn) throw new UsageError("Reader role guards require a live scan.");
  return options;
}
