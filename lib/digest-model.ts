export type StoredFile = {
  objectKey: string; objectName: string; kind: "evidence" | "export";
  recordedDigest: string | null; storedAt: string | null;
  exportId?: string; render?: "oscal" | "word" | "excel";
  replacementObjectKey?: string;
  title?: string; filename?: string; keptAt?: string | null;
  controlId?: string; evidenceId?: string; kept?: boolean;
};
export type FileComparison = StoredFile & {
  result: "match" | "mismatch" | "unreadable" | "unverified";
  recomputedDigest: string | null;
};
