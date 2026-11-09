import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalize } from "../collector/aws/jcs";
import { assertSchema, documentModel } from "../oscal/validate-schema";
export type BundleFile = { path: string; mediaType: string; bytes: Uint8Array };
export type Manifest = {
  schema: "binder.evidence-manifest.v1";
  createdAt: string;
  oscalVersion: "1.1.2";
  binderBuildSha: string;
  sourceRuns: {
    url: string;
    commit: string;
    runId: string;
    provenance?: "server-collector" | "caller-import";
  }[];
  artifacts: {
    path: string;
    mediaType: string;
    byteLength: number;
    sha256: string;
  }[];
  signing: {
    status: "signed" | "unsigned";
    algorithm: "ed25519";
    keyId: string | null;
    publicKey: string | null;
  };
  signature: string | null;
};
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function assertBundlePath(name: string) {
  if (
    !name ||
    name.length > 500 ||
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((p) => !p || p === "." || p === "..") ||
    name === "manifest.json"
  )
    throw new Error("Invalid bundle member path.");
}
function publicDer(key: KeyObject) {
  return key.export({ type: "spki", format: "der" }) as Buffer;
}
function publicKey(value: string) {
  const pem = Buffer.from(value, "base64").toString("utf8").trim();
  if (
    pem.length > 4096 ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(
      pem,
    )
  )
    throw new Error(
      "Manifest public key must be a single SPKI public PEM block.",
    );
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Manifest public key must be ed25519.");
  return key;
}
/** Publication reads only the configured public key and serializes a fresh public-only PEM. */
export function publishedManifestKey() {
  const value = process.env.AEGIS_MANIFEST_PUBLIC_KEY;
  if (!value) return null;
  try {
    const pub = publicKey(value);
    return {
      algorithm: "ed25519" as const,
      keyId: sha256(publicDer(pub)),
      publicKey: Buffer.from(
        pub.export({ type: "spki", format: "pem" }),
      ).toString("base64"),
    };
  } catch {
    throw new Error("Published manifest key is unavailable.");
  }
}
export function createManifest(
  files: BundleFile[],
  sourceRuns: Manifest["sourceRuns"] = [],
  now = new Date(),
): Manifest {
  const seen = new Set<string>();
  const artifacts = files
    .map((file) => {
      assertBundlePath(file.path);
      if (seen.has(file.path)) throw new Error("Duplicate bundle member.");
      seen.add(file.path);
      if (file.mediaType === "application/oscal+json")
        assertSchema(JSON.parse(Buffer.from(file.bytes).toString("utf8")));
      return {
        path: file.path,
        mediaType: file.mediaType,
        byteLength: file.bytes.length,
        sha256: sha256(file.bytes),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const signingValue = process.env.AEGIS_MANIFEST_SIGNING_KEY,
    publicValue = process.env.AEGIS_MANIFEST_PUBLIC_KEY;
  const unsigned: Manifest = {
    schema: "binder.evidence-manifest.v1",
    createdAt: now.toISOString(),
    oscalVersion: "1.1.2",
    binderBuildSha:
      process.env.AEGIS_COMMIT ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "unknown",
    sourceRuns,
    artifacts,
    signing: {
      status: "unsigned",
      algorithm: "ed25519",
      keyId: null,
      publicKey: null,
    },
    signature: null,
  };
  if (!signingValue) return unsigned;
  if (!publicValue)
    throw new Error("Manifest public key is required with a signing key.");
  let privateKey: KeyObject, pub: KeyObject;
  try {
    privateKey = createPrivateKey(
      Buffer.from(signingValue, "base64").toString("utf8"),
    );
    pub = publicKey(publicValue);
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      !publicDer(createPublicKey(privateKey)).equals(publicDer(pub))
    )
      throw new Error("mismatch");
  } catch {
    throw new Error("Manifest signing configuration is invalid.");
  }
  const manifest: Manifest = {
    ...unsigned,
    signing: {
      status: "signed",
      algorithm: "ed25519",
      keyId: sha256(publicDer(pub)),
      publicKey: Buffer.from(
        pub.export({ type: "spki", format: "pem" }),
      ).toString("base64"),
    },
  };
  const { signature: _signature, ...payload } = manifest;
  manifest.signature = sign(
    null,
    Buffer.from(canonicalize(payload)),
    privateKey,
  ).toString("base64");
  return manifest;
}
export function verifyManifest(
  manifest: Manifest,
  files: BundleFile[],
  suppliedPublicKey?: string,
): {
  status: "valid" | "invalid" | "unsigned";
  exitCode: 0 | 1 | 2;
  errors: string[];
  keyId?: string;
  trust?: string;
} {
  const errors: string[] = [];
  try {
    if (
      !manifest ||
      manifest.schema !== "binder.evidence-manifest.v1" ||
      manifest.oscalVersion !== "1.1.2" ||
      !Array.isArray(manifest.artifacts) ||
      !manifest.artifacts.length ||
      !manifest.signing ||
      manifest.signing.algorithm !== "ed25519"
    )
      throw new Error("Invalid manifest shape.");
    const seen = new Set<string>();
    const byPath = new Map<string, BundleFile>();
    for (const file of files) {
      assertBundlePath(file.path);
      if (byPath.has(file.path)) throw new Error("Duplicate bundle member.");
      byPath.set(file.path, file);
    }
    for (const item of manifest.artifacts) {
      assertBundlePath(item.path);
      if (seen.has(item.path)) throw new Error("Duplicate manifest member.");
      seen.add(item.path);
      const file = byPath.get(item.path);
      if (!file) {
        errors.push(item.path + ": missing");
        continue;
      }
      if (
        file.bytes.length !== item.byteLength ||
        sha256(file.bytes) !== item.sha256
      )
        errors.push(item.path + ": byte length or sha256 mismatch");
      if (item.mediaType === "application/oscal+json") {
        try {
          assertSchema(JSON.parse(Buffer.from(file.bytes).toString("utf8")));
        } catch {
          errors.push(item.path + ": OSCAL schema invalid");
        }
      }
    }
    for (const file of files)
      if (!seen.has(file.path))
        errors.push(file.path + ": unmanifested member");
    if (manifest.signing.status === "unsigned") {
      if (
        manifest.signature !== null ||
        manifest.signing.keyId !== null ||
        manifest.signing.publicKey !== null
      )
        errors.push("Inconsistent unsigned manifest.");
      return {
        status: errors.length ? "invalid" : "unsigned",
        exitCode: errors.length ? 1 : 2,
        errors,
      };
    }
    if (
      manifest.signing.status !== "signed" ||
      !manifest.signature ||
      !manifest.signing.publicKey
    )
      throw new Error("Invalid manifest signing status.");
    const pub = publicKey(suppliedPublicKey ?? manifest.signing.publicKey),
      embedded = publicKey(manifest.signing.publicKey);
    if (
      !publicDer(pub).equals(publicDer(embedded)) ||
      sha256(publicDer(pub)) !== manifest.signing.keyId
    )
      errors.push("Manifest signer differs from the expected public key.");
    const { signature, ...payload } = manifest;
    if (
      !verify(
        null,
        Buffer.from(canonicalize(payload)),
        pub,
        Buffer.from(signature, "base64"),
      )
    )
      errors.push("Manifest signature is invalid.");
    return {
      status: errors.length ? "invalid" : "valid",
      exitCode: errors.length ? 1 : 0,
      errors,
      keyId: manifest.signing.keyId ?? undefined,
      trust: suppliedPublicKey
        ? "supplied key"
        : "embedded key; compare fingerprint through an independent channel",
    };
  } catch {
    errors.push("Manifest is malformed or uses an invalid key.");
    return { status: "invalid", exitCode: 1, errors };
  }
}
