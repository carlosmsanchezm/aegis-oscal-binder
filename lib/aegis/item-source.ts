/** Server-authored provenance labels. A typed name is never an identity check. */
export type ItemSource =
  | { kind: "agent"; token_id: string }
  | {
      kind: "person";
      name?: string;
      identity_verification: "typed_unverified" | "unverified";
    }
  | { kind: "server-collected" };
export const personSource = (name?: string): ItemSource => ({
  kind: "person",
  ...(name ? { name } : {}),
  identity_verification: name ? "typed_unverified" : "unverified",
});
export const agentSource = (tokenId: string): ItemSource => ({
  kind: "agent",
  token_id: tokenId,
});
export function itemSource(value: unknown): ItemSource {
  if (value && typeof value === "object") {
    const s = value as ItemSource;
    if (s.kind === "agent" && /^[a-f0-9]{32}$/.test(s.token_id))
      return agentSource(s.token_id);
    if (s.kind === "server-collected") return { kind: "server-collected" };
    if (s.kind === "person") return personSource(s.name);
  }
  return personSource();
}
