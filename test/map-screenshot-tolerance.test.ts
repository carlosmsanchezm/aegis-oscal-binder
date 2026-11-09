import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
  compareMapScreenshots,
  mapScreenshotMaxDimensionDelta,
  mapScreenshotTolerance,
  type MapScreenshotImage,
} from "../lib/map-screenshot-tolerance";

const background: Color = [236, 236, 236, 255];
const panel: Color = [24, 32, 64, 255];
const ink: Color = [220, 30, 30, 255];
type Color = [number, number, number, number];

const linux = mapScreenshotTolerance("linux");
const darwin = mapScreenshotTolerance("darwin");

function blank(width: number, height: number, color: Color): MapScreenshotImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = color[3];
  }
  return { width, height, data };
}

function fillRect(image: MapScreenshotImage, x: number, y: number, width: number, height: number, color: Color) {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const index = (row * image.width + column) * 4;
      image.data[index] = color[0];
      image.data[index + 1] = color[1];
      image.data[index + 2] = color[2];
      image.data[index + 3] = color[3];
    }
  }
}

function clone(image: MapScreenshotImage): MapScreenshotImage {
  return { width: image.width, height: image.height, data: Buffer.from(image.data) };
}

function withScene(): MapScreenshotImage {
  const image = blank(200, 120, background);
  fillRect(image, 16, 20, 80, 64, panel);
  return image;
}

function withExtraHeight(image: MapScreenshotImage, extra: number): MapScreenshotImage {
  const taller = blank(image.width, image.height + extra, background);
  taller.data.set(image.data);
  return taller;
}

function paintPixels(image: MapScreenshotImage, count: number): MapScreenshotImage {
  const copy = clone(image);
  for (let n = 0; n < count; n++) fillRect(copy, 180 + (n % 10), Math.floor(n / 10), 1, 1, ink);
  return copy;
}

test("about 20px of map screenshot size difference passes and a larger size difference fails", () => {
  const scene = withScene();
  for (const options of [linux, darwin]) {
    const exact = compareMapScreenshots(clone(scene), scene, options);
    assert.equal(exact.pass, true);
    assert.equal(exact.diffPixels, 0);
    const twenty = compareMapScreenshots(withExtraHeight(scene, 20), scene, options);
    assert.equal(twenty.pass, true, twenty.message);
    assert.equal(twenty.heightDelta, 20);
    assert.equal(twenty.diffPixels, 0);
    const limit = compareMapScreenshots(withExtraHeight(scene, mapScreenshotMaxDimensionDelta), scene, options);
    assert.equal(limit.pass, true, limit.message);
    const over = compareMapScreenshots(withExtraHeight(scene, mapScreenshotMaxDimensionDelta + 1), scene, options);
    assert.equal(over.pass, false);
    assert.equal(over.reason, "dimension");
  }
  const wider = blank(scene.width + 20, scene.height, background);
  for (let y = 0; y < scene.height; y++) {
    wider.data.set(scene.data.subarray(y * scene.width * 4, (y + 1) * scene.width * 4), y * wider.width * 4);
  }
  const widthGap = compareMapScreenshots(wider, scene, linux);
  assert.equal(widthGap.pass, true, widthGap.message);
  assert.equal(widthGap.widthDelta, 20);
});

test("a missing element or a shifted panel still fails the map screenshot comparison", () => {
  const scene = withScene();
  const missing = blank(scene.width, scene.height, background);
  const shifted = blank(scene.width, scene.height, background);
  fillRect(shifted, 16 + 48, 20, 80, 64, panel);
  for (const options of [linux, darwin]) {
    for (const broken of [missing, shifted, withExtraHeight(missing, 20), withExtraHeight(shifted, 20)]) {
      const result = compareMapScreenshots(broken, scene, options);
      assert.equal(result.pass, false, result.message);
      assert.equal(result.reason, "pixels");
      assert.ok(result.diffPixels > result.allowedDiffPixels);
      assert.ok(result.diffPixelRatio > 0.002);
    }
  }
});

test("linux keeps a 0.002 pixel ratio and other platforms keep zero differing pixels", () => {
  const scene = withScene();
  const withinRatio = paintPixels(scene, 30);
  const overRatio = paintPixels(scene, 80);
  const linuxWithin = compareMapScreenshots(withinRatio, scene, linux);
  const linuxOver = compareMapScreenshots(overRatio, scene, linux);
  const darwinWithin = compareMapScreenshots(withinRatio, scene, darwin);
  assert.equal(linuxWithin.pass, true, linuxWithin.message);
  assert.ok(linuxWithin.diffPixelRatio < 0.002);
  assert.equal(linuxOver.pass, false);
  assert.equal(linuxOver.reason, "pixels");
  assert.equal(darwinWithin.pass, false);
  assert.equal(darwinWithin.reason, "pixels");
  assert.equal(darwin.maxDiffPixels, 0);
  assert.equal(linux.maxDiffPixelRatio, 0.002);
});

