import { accountFromRequest } from "../account/session";
import { readBuilderClaim, roleForBuilder } from "../account/store";
import { AgentAccessError } from "./agent-token";
/** Keep legacy owner records readable while requiring real ISSO membership for agent proposals. */
export async function requireIssoReview(
  req: Request,
  owner: string,
  agentAuthored: boolean,
) {
  const claim = await readBuilderClaim(owner);
  if (!claim && !agentAuthored) return;
  const account = await accountFromRequest(req),
    role = account ? await roleForBuilder(owner, account.uid) : null;
  if (role !== "isso")
    throw new AgentAccessError(
      "An authenticated ISSO must accept or reject this review.",
      403,
      "needs_human",
    );
}
