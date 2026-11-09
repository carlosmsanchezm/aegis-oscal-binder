import type { Principal, Role } from "./types";

const ID = /^[A-Za-z0-9._:-]{1,80}$/;

export function principalId(value: string): string {
  if (!ID.test(value)) throw new Error("Principal id is not usable.");
  return value;
}

export function humanPrincipal(input: {
  id: string;
  role: Role;
  projects: readonly string[];
  environments: readonly string[];
  governmentOfficial?: boolean;
}): Principal {
  return {
    kind: "human",
    id: principalId(input.id),
    role: input.role,
    projects: [...input.projects],
    environments: [...input.environments],
    governmentOfficial: input.governmentOfficial === true,
  };
}

/** Non-human principal. Role stays null and the official attribute stays false. */
export function agentPrincipal(input: { id: string; projects: readonly string[]; environments: readonly string[] }): Principal {
  return {
    kind: "aegis-agent",
    id: principalId(input.id),
    role: null,
    projects: [...input.projects],
    environments: [...input.environments],
    governmentOfficial: false,
  };
}
