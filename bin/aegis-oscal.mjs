#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const entry = path.join(here, "aegis-oscal.ts");
const result = spawnSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
