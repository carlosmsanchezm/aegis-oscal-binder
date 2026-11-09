import { AgentAccessError } from "./agent-token";
import type { Chained } from "../immutable-log";
type Cursor = { v: 1; chain: string; sequence: number; hash: string };
export function pageLog<T>(
  entries: Chained<T>[],
  query: URLSearchParams,
  chain: string,
  anchors: Chained<T>[] = entries,
) {
  const rawLimit = query.get("limit"),
    limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new AgentAccessError(
      "Limit must be an integer from 1 to 200.",
      400,
      "invalid_request",
    );
  let after = -1;
  const since = query.get("since");
  if (since !== null) {
    try {
      if (!since || since.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(since))
        throw new Error();
      const c = JSON.parse(
        Buffer.from(since, "base64url").toString("utf8"),
      ) as Cursor;
      if (
        c.v !== 1 ||
        c.chain !== chain ||
        !Number.isSafeInteger(c.sequence) ||
        c.sequence < 0 ||
        anchors.find((e) => e.sequence === c.sequence)?.hash !== c.hash
      )
        throw new Error();
      after = c.sequence;
    } catch {
      throw new AgentAccessError(
        "Cursor does not match this chain.",
        400,
        "invalid_request",
      );
    }
  }
  const remaining = entries.filter((e) => e.sequence > after);
  const page = remaining.slice(0, limit),
    last = page.at(-1);
  const cursor = last
    ? Buffer.from(
        JSON.stringify({
          v: 1,
          chain,
          sequence: last.sequence,
          hash: last.hash,
        } satisfies Cursor),
      ).toString("base64url")
    : since;
  const has_more = remaining.length > limit;
  return {
    entries: page,
    cursor,
    next_cursor: has_more ? cursor : null,
    has_more,
  };
}
