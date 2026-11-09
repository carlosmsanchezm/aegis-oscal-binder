import { sha256Bytes } from "./hash";

export type MeasurementSample = {
  min: number;
  median: number;
  max: number;
  unit: "ms";
  runs: number[];
};

export type MeasurementPayload = {
  controls: number;
  runs: number;
  commit: string;
  node: string;
  platform: string;
  cpuCount: number;
  recordedAt: string;
  samples: {
    import: MeasurementSample;
    gate: MeasurementSample;
    export: MeasurementSample;
    schema: MeasurementSample;
    roundTrip: MeasurementSample;
  };
  proposal: string;
};

export type MeasurementRecord =
  | { measurement: MeasurementPayload; digest: string }
  | { measurement: null; reason: "NO_MEASUREMENT" | "MEASUREMENT_UNREADABLE" | "DIGEST_MISMATCH" };

function isSample(value: unknown): value is MeasurementSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<MeasurementSample>;
  return typeof sample.min === "number"
    && typeof sample.median === "number"
    && typeof sample.max === "number"
    && sample.unit === "ms"
    && Array.isArray(sample.runs)
    && sample.runs.every((item) => typeof item === "number");
}

function isPayload(value: unknown): value is MeasurementPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<MeasurementPayload>;
  const samples = payload.samples;
  if (!samples) return false;
  return typeof payload.controls === "number"
    && typeof payload.runs === "number"
    && typeof payload.commit === "string"
    && typeof payload.node === "string"
    && typeof payload.platform === "string"
    && typeof payload.cpuCount === "number"
    && typeof payload.recordedAt === "string"
    && typeof payload.proposal === "string"
    && isSample(samples.import)
    && isSample(samples.gate)
    && isSample(samples.export)
    && isSample(samples.schema)
    && isSample(samples.roundTrip);
}

/** Digest is SHA-256 of JSON.stringify(payload), the same bytes the route checks. */
export function sealMeasurement(payload: MeasurementPayload): { payload: MeasurementPayload; digest: string } {
  return { payload, digest: sha256Bytes(JSON.stringify(payload)) };
}

export function readMeasurementText(text: string | null): MeasurementRecord {
  if (text == null) return { measurement: null, reason: "NO_MEASUREMENT" };
  let parsed: { payload?: unknown; digest?: unknown };
  try {
    parsed = JSON.parse(text) as { payload?: unknown; digest?: unknown };
  } catch {
    return { measurement: null, reason: "MEASUREMENT_UNREADABLE" };
  }
  if (!isPayload(parsed.payload) || typeof parsed.digest !== "string") {
    return { measurement: null, reason: "MEASUREMENT_UNREADABLE" };
  }
  if (sha256Bytes(JSON.stringify(parsed.payload)) !== parsed.digest) {
    return { measurement: null, reason: "DIGEST_MISMATCH" };
  }
  return { measurement: parsed.payload, digest: parsed.digest };
}
