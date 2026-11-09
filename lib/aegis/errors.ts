export class AegisError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status = 400, details: unknown = null) {
    super(message);
    this.name = "AegisError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type EvidenceProblem = {
  code: "TITLE_REQUIRED" | "TYPE_UNKNOWN" | "DUPLICATE_TITLE" | "INVALID_URL" | "MISSING_FILE";
  message: string;
};
