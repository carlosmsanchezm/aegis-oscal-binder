import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

// Some Git providers omit VERCEL_GIT_COMMIT_SHA. Capture the checked out commit at build time.
function buildCommit(): string {
  const configured = process.env.VERCEL_GIT_COMMIT_SHA || process.env.AEGIS_COMMIT;
  if (configured) return configured;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    AEGIS_BUILD_COMMIT: buildCommit(),
  },
  output: "standalone",
  // Catalog and gold fixture are read from disk at request time (not imported).
  // Include them in every serverless bundle so the shell can list FedRAMP baselines.
  outputFileTracingIncludes: {
    "/": ["./catalogs/**/*", "./fixtures/**/*", "./schemas/oscal/**/*"],
    "/*": ["./catalogs/**/*", "./fixtures/**/*", "./schemas/oscal/**/*"],
    "/**/*": ["./catalogs/**/*", "./fixtures/**/*", "./schemas/oscal/**/*"],
    "/api/**/*": ["./catalogs/**/*", "./fixtures/**/*", "./schemas/oscal/**/*"],
  },
  // Session files are created at runtime. Do not bake a workspace .data tree into the image.
  outputFileTracingExcludes: {
    "*": [".data/**/*", "./.data/**/*"],
  },
};

export default nextConfig;
