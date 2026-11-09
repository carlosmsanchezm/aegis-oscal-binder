import React from "react";
import {it, expect, vi} from "vitest";
import {render, screen, fireEvent, waitFor} from "@testing-library/react";
import {ReleaseBundleStrip} from "../../components/binder/ReleaseBundleStrip";
import {PackageMap} from "../../components/binder/PackageMap";
import type {ReleaseEvidence} from "../../lib/aegis/release-evidence";
import {map, records} from "../pmap-r2-fixture";
vi.mock("../../components/binder/ControlFocus", async importOriginal => ({...await importOriginal<typeof import("../../components/binder/ControlFocus")>(), useStageSize: () => ({width: 1280, height: 500, gutter: 0})}));
const bundle: ReleaseEvidence = {
  schema: "binder.release-evidence.v1", connectionId: "00000000-0000-0000-0000-000000000000",
  repository: "https://github.com/example/service", releaseId: "shipped-release", releaseSha256: "d".repeat(64),
  commitSha: "c".repeat(40), previousCommitSha: "a".repeat(40), tagOrDeploy: "900",
  collectedAt: "2026-10-30T04:00:00Z", releaseUrl: "https://github.com/example/service/actions/runs/900",
  rangeStatus: "verified", items: [{
    poamItemId: "item-one", findingId: "scan-aabbccdd", sourceReleaseId: "source", controlId: map.controls[0].id,
    prNumber: 7, prUrl: "https://github.com/example/service/pull/7", mergeSha: "b".repeat(40),
    ciRunId: "700", ciRunUrl: "https://github.com/example/service/actions/runs/700", ciRuns: [{id: "700", url: "https://github.com/example/service/actions/runs/700"}],
    retestResult: "pass", retestReceiptId: "d".repeat(64),
  }],
};
it("the strip renders compact passing tiles, opens the existing item inspector, and contains no prose dump", () => {
  const open = vi.fn();
  const {container, rerender} = render(<ReleaseBundleStrip bundle={bundle} onOpen={open}/>);
  expect(container.querySelectorAll("p")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", {name: /PR #7/}));
  expect(open).toHaveBeenCalledWith("item-one");
  expect(screen.getByRole("button").title).toMatch(/Human closure/);
  rerender(<ReleaseBundleStrip bundle={{...bundle, items: [{...bundle.items[0], retestResult: "remaining"}]}} onOpen={open}/>);
  expect(screen.queryByTestId("release-bundle-strip")).toBeNull();
  rerender(<ReleaseBundleStrip bundle={{...bundle, rangeStatus: "unverified"}} onOpen={open}/>);
  expect(screen.queryByTestId("release-bundle-strip")).toBeNull();
});
it("only verified controls become links to the selected release; failures preserve the normal map button", async () => {
  vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
  const props = {pkg: map, snapshotSelector: <span>Synthetic bundle fixture</span>, selectedId: null,
    level2: false, selectedItemId: null, onSelect: vi.fn(), onEnterFocus: vi.fn(), onLeaveFocus: vi.fn(), onSelectItem: vi.fn()};
  const {container, rerender} = render(<PackageMap {...props} pipelineEvidence={{...records[1], releaseEvidence: bundle}}/>);
  const tile = container.querySelector('[data-control-id="' + bundle.items[0].controlId + '"]')!;
  expect(tile.tagName).toBe("A"); expect(tile.getAttribute("data-release-fixed")).toBe("true");
  expect(tile.getAttribute("href")).toContain("release=shipped-release"); expect(tile.textContent).toContain("retest passed");
  rerender(<PackageMap {...props} pipelineEvidence={{...records[1], releaseEvidence: {...bundle, items: [{...bundle.items[0], retestResult: "remaining"}]}}}/>);
  const normal = container.querySelector('[data-control-id="' + bundle.items[0].controlId + '"]')!;
  expect(normal.tagName).toBe("BUTTON"); expect(normal.hasAttribute("data-release-fixed")).toBe(false);
  fireEvent.click(normal); await waitFor(() => expect(props.onSelect).toHaveBeenCalled());
});
