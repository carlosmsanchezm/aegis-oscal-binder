import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Frame25View } from "../components/m1/Frame25";
import { M1Chrome } from "../components/m1/M1Chrome";
import { HONESTY } from "../lib/m1/copy";
import { frame25State } from "../lib/m1/state";
import { toResult, toStored } from "../lib/m1/api";

describe("M1 rendered limitations", () => {
  it("renders missing digests separately without claiming all files match", () => {
    const file = { objectKey: "a".repeat(64), objectName: "evidence.json", kind: "evidence" as const, recordedDigest: null, storedAt: null };
    const objects = [toStored(file)];
    const state = frame25State({ objects, check: { checkedAt: "2026-10-06T18:39:19Z", results: [toResult({ ...file, result: "unverified", recomputedDigest: null })] }, progress: null, failed: false });
    const html = renderToStaticMarkup(createElement(Frame25View, { workspace: "classic", objects, state }));
    expect(html).toContain('data-state="results"');
    expect(html).toContain('data-testid="m1-unverified"');
    expect(html).not.toContain('data-testid="m1-all-match"');
    expect(html).toContain('data-testid="m1-verify-row"');
    expect(html).toContain('data-status="unverified"');
    expect(html).toContain("No recorded digest");
    expect(html).toContain(HONESTY);
  });

  it.each(["empty", "error"] as const)("keeps the literal limitation in the %s card and title", kind => {
    const html = renderToStaticMarkup(createElement(Frame25View, { workspace: "classic", objects: [], state: { kind } }));
    expect(html.split(HONESTY)).toHaveLength(3);
    expect(html).toContain(`data-state="${kind}"`);
  });

  it("renders the caller's build identity and no sample package metadata", () => {
    const html = renderToStaticMarkup(createElement(M1Chrome, { header: null, tab: "release", workspace: "classic", buildSha: "unknown", children: null }));
    expect(html).toContain("OSCAL binder alpha");
    expect(html).toContain("build unknown");
    expect(html).not.toContain("94db668");
    expect(html).toContain("No package loaded");
    expect(html).not.toContain("Gold fixture CSP boundary");
  });
});
