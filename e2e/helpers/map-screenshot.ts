import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { expect, type Locator, type TestInfo } from "@playwright/test";
import { compareMapScreenshots, mapScreenshotTolerance } from "../../lib/map-screenshot-tolerance";

/** Screenshot assertion used by the map guard. Does not write or replace baselines. */
export async function expectMapScreenshot(locator: Locator, name: string, info: TestInfo) {
  const actualBytes = await locator.screenshot({ animations: "disabled" });
  const snapshotPath = info.snapshotPath(name, { kind: "screenshot" });
  // Named actuals are review evidence for explicitly approved baseline changes.
  // The guard still only reads its committed baseline and never updates it.
  writeFileSync(info.outputPath(`actual-${name}`), actualBytes);
  let expectedBytes: Buffer;
  try {
    expectedBytes = readFileSync(snapshotPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Missing map screenshot baseline ${snapshotPath}. The guard does not create baselines. ${reason}`);
  }
  const actual = PNG.sync.read(actualBytes);
  const expected = PNG.sync.read(expectedBytes);
  const result = compareMapScreenshots(actual, expected, mapScreenshotTolerance());
  if (!result.pass) {
    await info.attach("map-screenshot-actual", { body: actualBytes, contentType: "image/png" });
    await info.attach("map-screenshot-expected", { body: expectedBytes, contentType: "image/png" });
    // Preserve the public build fonts when a runner renders differently. This is
    // diagnostic evidence only; the comparison and its allowance stay unchanged.
    const fontFaces = await locator.evaluate(() => ({
      loaded: Array.from(document.fonts).map(font => ({family: font.family, weight: font.weight, status: font.status})),
      faces: Array.from(document.styleSheets).flatMap(sheet => {
        try {return Array.from(sheet.cssRules).filter(rule => rule instanceof CSSFontFaceRule).map(rule => rule.cssText);}
        catch {return [];}
      }),
    }));
    const fontFacePath = info.outputPath(`${name}-font-faces.json`);
    writeFileSync(fontFacePath, JSON.stringify(fontFaces, null, 2));
    await info.attach("map-font-faces", {path: fontFacePath, contentType: "application/json"});
    const media = path.join(process.cwd(), ".next/static/media");
    for (const file of readdirSync(media).filter(file => file.endsWith(".woff2")))
      await info.attach(`map-font-${file}`, {path: path.join(media, file), contentType: "font/woff2"});
    expect(result.pass, `${result.message} Baseline: ${snapshotPath}`).toBe(true);
  }
}
