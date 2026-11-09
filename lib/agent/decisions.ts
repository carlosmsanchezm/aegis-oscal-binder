import { listApprovals, triageApprovals } from "./approvals";
import { listConnections, builderOwner } from "../server/builder-store";
import { getSession } from "../aegis/store";
import { AgentAccessError, authenticateAgent } from "./agent-token";
import { withSession } from "../server/http";
import { apiJson, agentHttpError } from "./http";
export const DECISION_ROLES = [
  "isso",
  "isse",
  "system-owner",
  "developer",
  "assessor",
] as const;
export function filterDecisions<
  T extends { required_role: string; workflow_step: string },
>(items: T[], q: URLSearchParams) {
  const role = q.get("role")?.toLowerCase().replaceAll(" ", "-"),
    step = q.get("step")?.toLowerCase();
  if (role && !(DECISION_ROLES as readonly string[]).includes(role))
    throw new AgentAccessError(
      "Use ISSO, ISSE, system owner, developer or assessor as the role filter.",
      400,
      "invalid_request",
    );
  if (
    step &&
    !["finding", "poam", "milestone", "retest", "closure-review"].includes(step)
  )
    throw new AgentAccessError(
      "Use an existing finding, POA&M, milestone, retest or closure-review step.",
      400,
      "invalid_request",
    );
  return items.filter(
    (i) =>
      (!role || i.required_role === role) &&
      (!step ||
        i.workflow_step === step ||
        (step === "milestone" && i.workflow_step === "poam")),
  );
}
export async function connectionDecisions(
  connectionId: string,
  sessionId: string,
  origin: string,
) {
  return [
    ...(await listApprovals(connectionId, sessionId, origin)),
    ...(await triageApprovals(connectionId, sessionId)),
  ];
}
export async function workspaceDecisions(req: Request) {
  if (req.headers.has("authorization")) {
    try {
      await authenticateAgent(
        /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1],
        "read_findings",
      );
      return agentHttpError(
        new AgentAccessError(
          "Agent credentials are bound to one system. Pass its connection id.",
          403,
          "scope",
        ),
      );
    } catch (e) {
      return agentHttpError(e);
    }
  }
  return withSession(req, async () => {
    try {
      const owner = builderOwner(req.headers.get("cookie"));
      if (!owner) throw new AgentAccessError("Workspace owner required.", 403);
      const q = new URL(req.url).searchParams,
        system = q.get("system");
      const systems = (await listConnections(owner)).filter(
        (c) => !c.revokedAt && (!system || c.id === system),
      );
      const items = (
        await Promise.all(
          systems.map(async (c) =>
            (
              await connectionDecisions(
                c.id,
                getSession().id,
                new URL(req.url).origin,
              )
            ).map((i) => ({
              ...i,
              connection_id: c.id,
              system: { id: c.id, name: c.name },
            })),
          ),
        )
      ).flat();
      return apiJson({
        items: filterDecisions(items, q),
        systems: systems.map((c) => ({ id: c.id, name: c.name })),
        label: "Needs a decision",
      });
    } catch (e) {
      return agentHttpError(e);
    }
  });
}
