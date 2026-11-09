import { readFileSync } from "node:fs";
import { AegisError, emptyPersisted, exportOscal, findRepoRoot, getPackageState, loadFixture, validateOscal } from "../lib/aegis";
import type { PersistedState } from "../lib/aegis";
import { runAwsScan } from "../lib/collector/aws/run";

type Opts = {
  fixture?: string;
  out?: string;
  state?: string;
  scenario?: string;
  help?: boolean;
};

const HELP = `aegis-oscal — CLI peer for the OSCAL binder (same IR and gold fixture)

  aegis-oscal validate --fixture gold
  aegis-oscal export --fixture gold --out out/

The stock gold fixture is incomplete (3 of 12). Completeness stays FAIL.
Export still writes a WIP artifact. Validate checks the written OSCAL and
does not treat completeness FAIL as an authorization result.

  aegis-oscal validate --fixture gold --state .data/workspace.json
  aegis-oscal export --fixture gold --state .data/workspace.json --out out/
  aegis-oscal validate --fixture gold --state .data/workspace.json --scenario red
  aegis-oscal aws-scan --fixture fixtures/aws/empty-account --out out/aws-reader

aws-scan collects read-only GovCloud evidence through the shared collector.
Pass --fixture or --profile. It does not write to AWS.

--state reads a workspace file and does not write it back. --scenario red
re-serializes a complete package with the three named defects. It does not
overwrite the written export file.
`;

function parse(argv: string[]): { command?: string; opts: Opts } {
  const opts: Opts = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--fixture" || arg === "--out" || arg === "--state" || arg === "--scenario") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`Missing value for ${arg}`);
        process.exit(2);
      }
      opts[arg.slice(2) as "fixture" | "out" | "state" | "scenario"] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`Unknown option ${arg}`);
      process.exit(2);
    }
    positional.push(arg);
  }
  return { command: positional[0], opts };
}

function loadState(opts: Opts, root: string): PersistedState {
  if (opts.fixture !== "gold") {
    console.error('Pass --fixture gold. The only built-in fixture is "gold".');
    process.exit(2);
  }
  if (!opts.state) return loadFixture(emptyPersisted(), "gold", { root });
  const parsed = JSON.parse(readFileSync(opts.state, "utf8")) as PersistedState;
  if (parsed.version !== 1) {
    console.error("Unsupported workspace file.");
    process.exit(2);
  }
  return parsed;
}

function reportCompleteness(root: string, state: PersistedState): ReturnType<typeof getPackageState> {
  const pkg = getPackageState(state, { root });
  if (pkg.gate.status === "EMPTY") {
    console.error("Load an OSCAL package or the gold fixture first.");
    process.exit(1);
  }
  if (pkg.gate.status === "FAIL") {
    console.error(`completeness FAIL · ${pkg.gate.label}`);
    console.error("missing required IR fields (implementation, responsible role, or evidence)");
    console.error("not an authorization result");
    if (pkg.gate.incompleteControlIds.length > 0) {
      console.error(`incomplete: ${pkg.gate.incompleteControlIds.join(", ")}`);
    }
  } else {
    console.error(`completeness PASS · ${pkg.gate.label}`);
  }
  return pkg;
}

async function main(): Promise<void> {
  if(process.argv[2] === "verify"){
    const args=process.argv.slice(3),i=args.indexOf("--bundle");if(i<0||!args[i+1])throw new Error("Pass --bundle <dir|zip>.");
    const {verifyBundlePath}=await import("../lib/manifest/bundle");
    const k=args.indexOf("--public-key"),key=k<0?process.env.AEGIS_MANIFEST_PUBLIC_KEY:readFileSync(args[k+1],"utf8").trim();
    try{const result=verifyBundlePath(args[i+1],key);console.log(JSON.stringify(result,null,2));process.exitCode=result.exitCode;}catch{console.log(JSON.stringify({status:"invalid",exitCode:1,errors:["Malformed or unsafe bundle."]}));process.exitCode=1;}return;
  }
  if(process.argv[2] === "agent-token"){const {agentTokenCli}=await import("../lib/agent/cli");await agentTokenCli(process.argv.slice(3));return;}
  if (process.argv[2] === "aws-scan") process.exit(runAwsScan(process.argv.slice(3)));
  if(process.argv[2] === "validate"&&process.argv.includes("--file")){
    const file=process.argv[process.argv.indexOf("--file")+1],{validateSchema}=await import("../lib/oscal/validate-schema");const result=validateSchema(JSON.parse(readFileSync(file,"utf8")));console.log(JSON.stringify(result,null,2));process.exitCode=result.valid?0:1;return;
  }
  if(process.argv[2] === "export-bundle"){
    const args=process.argv.slice(3),connection=args[args.indexOf("--connection")+1],out=args[args.indexOf("--out")+1];
    if(!args.includes("--connection")||!args.includes("--out"))throw new Error("Pass --connection and --out.");
    const {ownsConnection,readConnection}=await import("../lib/server/builder-store");const record=await readConnection(connection);if(!record||!ownsConnection(record,process.env.AEGIS_OWNER_SECRET??null))throw new Error("Owner credential required.");
    const {exportConnectionBundle}=await import("../lib/oscal/connection-export"),{writeBundleDirectory}=await import("../lib/manifest/bundle");const oi=args.indexOf("--origin"),origin=new URL(oi<0?"http://localhost:3000":args[oi+1]);if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password)throw new Error("Invalid public origin.");const result=await exportConnectionBundle(connection,process.env.AEGIS_SESSION_ID,origin.origin);writeBundleDirectory(out,result.files,result.manifest.sourceRuns);console.log("Evidence bundle exported; manifest "+result.manifest.signing.status);return;
  }
  const { command, opts } = parse(process.argv.slice(2));
  if (opts.help || !command) {
    process.stdout.write(HELP);
    process.exit(opts.help || command === undefined ? 0 : 2);
  }
  if (command !== "validate" && command !== "export") {
    console.error(`Unknown command ${command}`);
    process.stdout.write(HELP);
    process.exit(2);
  }
  const root = findRepoRoot();
  const state = loadState(opts, root);
  const pkg = reportCompleteness(root, state);
  if (command === "export") {
    if (!opts.out) {
      console.error("Pass --out <directory>.");
      process.exit(2);
    }
    try {
      const result = exportOscal(state, { root, outDir: opts.out });
      console.log(`wrote ${result.filePath}`);
      console.log(`evidence bundle ${result.bundlePath}`);
      console.log(result.exportId);
      console.log(result.filename);
      console.log(pkg.gate.status === "PASS" ? "gate PASS" : "gate FAIL · WIP export written");
      console.log("session not modified");
      process.exit(0);
    } catch (error) {
      if (error instanceof AegisError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  }
  const scenario = opts.scenario ?? "current";
  if (scenario !== "current" && scenario !== "red") {
    console.error('scenario must be "current" or "red"');
    process.exit(2);
  }
  try {
    const result = validateOscal(state, { root }, scenario);
    console.log(`validator ${result.validation.status}`);
    console.log(`${result.validation.errors.length} errors`);
    for (const error of result.validation.errors) {
      console.log(`${error.id}\t${error.check}\t${error.message}\t${error.oscalPath}\t${error.sourceInIr}`);
    }
    console.log("session not modified");
    process.exit(result.validation.status === "GREEN" ? 0 : 1);
  } catch (error) {
    if (error instanceof AegisError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

main().catch(()=>{console.error("CLI operation failed; check arguments and configuration.");process.exitCode=1;});
