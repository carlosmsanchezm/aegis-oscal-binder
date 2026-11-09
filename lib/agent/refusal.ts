import { AgentAccessError } from "./agent-token";
import { AegisError } from "../aegis/errors";
export type RefusalCode =
  | "token_expired"
  | "scope"
  | "needs_server_evidence"
  | "needs_human"
  | "authentication"
  | "invalid_request"
  | "operation_failed";
export function refusalCode(error: unknown): RefusalCode {
  if (error instanceof AgentAccessError) return error.code;
  if (error instanceof AegisError && error.code === "EVIDENCE_REQUIRED")
    return "needs_server_evidence";
  return "operation_failed";
}
export function legacyRefusalCode(message: string): RefusalCode {
  if (/scope is required/i.test(message)) return "scope";
  if (/collector|collected retest|server.collect/i.test(message))
    return "needs_server_evidence";
  if (/person|human|already recorded closure/i.test(message))
    return "needs_human";
  return "operation_failed";
}
