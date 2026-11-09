import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const lockName = ".aegis-build.lock";

export function acquireBuildLock(root) {
  const lockPath = path.join(realpathSync(root), lockName);
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = "unknown";
    try { owner = JSON.parse(readFileSync(lockPath, "utf8")).pid; } catch { /* Another process may still be writing its owner. */ }
    throw new Error(`Production build already owns this checkout (PID ${owner}). Wait for it to finish. If it stopped unexpectedly, verify that process is no longer running before removing ${lockPath}.`);
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(lockPath);
    throw error;
  }
  return () => { closeSync(descriptor); unlinkSync(lockPath); };
}

export function verifyBuildOutput(root) {
  const server = path.join(root, ".next", "server");
  const manifest = JSON.parse(readFileSync(path.join(server, "pages-manifest.json"), "utf8"));
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object" || !Object.keys(manifest).length) {
    throw new Error("Production build produced an empty or invalid pages manifest.");
  }
  for (const file of Object.values(manifest)) {
    if (typeof file !== "string" || !existsSync(path.join(server, file))) {
      throw new Error(`Production build is missing a page referenced by its manifest: ${file}`);
    }
  }
  if (!readFileSync(path.join(root, ".next", "BUILD_ID"), "utf8").trim()) {
    throw new Error("Production build produced an empty build ID.");
  }
}

export async function runProductionBuild(root = process.cwd(), args = process.argv.slice(2)) {
  root = realpathSync(root);
  const release = acquireBuildLock(root);
  let child;
  const forward = (signal) => child?.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  try {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const code = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build", ...args], { cwd: root, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
    if (code === 0) verifyBuildOutput(root);
    return code;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    release();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runProductionBuild(); }
  catch (error) { console.error(`Production build failed: ${error.message}`); process.exitCode = 1; }
}
