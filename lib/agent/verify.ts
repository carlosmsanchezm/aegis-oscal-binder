import { verifyAgentActivity } from "./audit";
import { verifyTimeline } from "../timeline/store";
export async function verifyConnectionChains(connectionId: string) {
  const [audit, evidence] = await Promise.all([
    verifyAgentActivity(connectionId),
    verifyTimeline(connectionId),
  ]);
  return { ...evidence, valid: audit.valid && evidence.valid, audit, evidence };
}
