import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sha256Bytes } from "../lib/aegis/hash";
import { AegisError } from "../lib/aegis/errors";
import { blobGetBytes, blobPutBytes, blobToken } from "../lib/durable";
import { digestObjectKey, listDigestAuditPaths, ownerForStoredObject } from "../lib/digest-audit";
import { flushRetainedWrites, readRetained, resetRetainedForTests, retainBytes } from "../lib/retained-bytes";
import { evidenceBlobKey, exportBlobKey } from "../lib/storage-key";

const payload = Buffer.from("retention sample bytes");
const xml = Buffer.from("<export>retention sample bytes</export>", "utf8");

async function removeBlob(keys: string[], token: string): Promise<void> {
  const { del } = await import("@vercel/blob");
  for (const key of keys) {
    try {
      await del(key, { token });
    } catch {
      process.stderr.write(`cleanup failed for ${key}\n`);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV === "production") {
    process.stderr.write("Refusing to write a retention check into the production store.\n");
    process.exit(2);
  }
  const token = blobToken();
  const useBlob = Boolean(token) && !process.env.AEGIS_DATA_DIR?.trim();
  const created: string[] = [];
  let cleanupDir: string | null = null;
  try {
    let evidenceLocation: string;
    let exportLocation: string;
    if (useBlob) {
      const owner = randomBytes(16).toString("hex");
      evidenceLocation = evidenceBlobKey(owner, "AU-2", "retention-note.txt");
      exportLocation = exportBlobKey(owner, "retention-check.xml");
    } else {
      cleanupDir = mkdtempSync(path.join(tmpdir(), "aegisRetain"));
      evidenceLocation = path.join(cleanupDir, "evidence.bin");
      exportLocation = path.join(cleanupDir, "export.xml");
    }
    const evidence = retainBytes({ location: evidenceLocation, bytes: payload, contentType: "application/octet-stream", label: "Evidence file" });
    const exported = retainBytes({ location: exportLocation, bytes: xml, contentType: "application/xml", label: "Export" });
    created.push(evidence.location, exported.location);
    await flushRetainedWrites();
    const evidenceBack = await readRetained(evidence.location, evidence.sha256, "Evidence file");
    const exportBack = await readRetained(exported.location, exported.sha256, "Export");
    if (!evidenceBack || !exportBack || !evidenceBack.equals(payload) || !exportBack.equals(xml)) {
      throw new Error("Stored bytes were not readable.");
    }
    if (evidence.sha256 !== sha256Bytes(payload) || exported.sha256 !== sha256Bytes(xml)) {
      throw new Error("Recorded digest did not match.");
    }
    const mode = useBlob ? "blob" : "directory";
    process.stdout.write(`round trip ok ${mode}\n`);
    const flipped = Buffer.from(payload);
    flipped[0] = flipped[0] === 0x72 ? 0x73 : 0x72;
    if (useBlob) await blobPutBytes(evidence.location, flipped, true, "application/octet-stream");
    else writeFileSync(evidence.location, flipped);
    let refused = false;
    try {
      await readRetained(evidence.location, evidence.sha256, "Evidence file");
    } catch (error) {
      refused = error instanceof AegisError && error.code === "DIGEST_MISMATCH";
    }
    if (!refused) throw new Error("Tampered bytes were not refused.");
    if (useBlob) {
      const still = await blobGetBytes(evidence.location);
      if (!still || still.equals(payload)) throw new Error("Tamper did not change stored bytes.");
    }
    process.stdout.write("tamper refused\n");
  } finally {
    const auditPaths: string[] = [];
    for (const location of created) {
      try {
        auditPaths.push(...await listDigestAuditPaths(ownerForStoredObject(location), digestObjectKey(location)));
      } catch {
        process.stderr.write(`cleanup failed for audits of ${location}\n`);
      }
    }
    if (useBlob) created.push(...auditPaths.filter((item) => item.startsWith("aegis/")));
    else {
      for (const file of auditPaths) {
        try {
          unlinkSync(file);
        } catch {
          process.stderr.write(`cleanup failed for ${file}\n`);
        }
      }
    }
    if (useBlob && token) await removeBlob(created, token);
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
    resetRetainedForTests();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Retention check failed.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
