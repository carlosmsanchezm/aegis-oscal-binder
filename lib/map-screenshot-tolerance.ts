import pixelmatch from "pixelmatch";

/** Playwright's perceived-color threshold. Pixels within it, and anti-aliased pixels, are not diffs. */
export const mapScreenshotColorThreshold = 0.2;

/**
 * Largest width or height gap still compared. Covers the recorded ~20px
 * Mac/Linux map-screenshot gap, with a few pixels of headroom.
 */
export const mapScreenshotMaxDimensionDelta = 24;

/** Linux allowance for minor glyph antialiasing inside the compared rectangle. */
export const mapScreenshotLinuxMaxDiffPixelRatio = 0.002;

export type MapScreenshotImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type MapScreenshotTolerance = {
  maxDimensionDelta: number;
  colorThreshold: number;
  maxDiffPixelRatio?: number;
  maxDiffPixels?: number;
};

export type MapScreenshotCompareResult = {
  pass: boolean;
  reason: "match" | "dimension" | "pixels";
  message: string;
  widthDelta: number;
  heightDelta: number;
  comparedWidth: number;
  comparedHeight: number;
  diffPixels: number;
  allowedDiffPixels: number;
  diffPixelRatio: number;
};

export function mapScreenshotTolerance(platform: NodeJS.Platform = process.platform): MapScreenshotTolerance {
  const shared = {
    maxDimensionDelta: mapScreenshotMaxDimensionDelta,
    colorThreshold: mapScreenshotColorThreshold,
  };
  if (platform === "linux") return { ...shared, maxDiffPixelRatio: mapScreenshotLinuxMaxDiffPixelRatio };
  return { ...shared, maxDiffPixels: 0 };
}

function assertImage(image: MapScreenshotImage, label: string) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1) {
    throw new Error(`${label} map screenshot must have positive integer dimensions.`);
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error(`${label} map screenshot byte length does not match ${image.width}x${image.height}.`);
  }
}

function cropTopLeft(image: MapScreenshotImage, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = y * image.width * 4;
    out.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return out;
}

function result(
  partial: Omit<MapScreenshotCompareResult, "message" | "diffPixelRatio"> & { message?: string },
): MapScreenshotCompareResult {
  const area = partial.comparedWidth * partial.comparedHeight;
  const diffPixelRatio = area > 0 ? partial.diffPixels / area : 0;
  return { ...partial, diffPixelRatio, message: partial.message ?? "" };
}

/**
 * Compare map screenshots.
 *
 * A width or height difference of at most `maxDimensionDelta` is not itself a
 * failure. Both images are cropped to the shared top-left rectangle and that
 * rectangle is compared with pixelmatch, using the same color threshold as
 * Playwright. A larger dimension change fails before the pixel rule. A missing
 * element or shifted panel inside the shared rectangle still fails that rule.
 * `diffPixels > allowed` matches Playwright: an exact allowance still passes.
 */
export function compareMapScreenshots(
  actual: MapScreenshotImage,
  expected: MapScreenshotImage,
  options: MapScreenshotTolerance,
): MapScreenshotCompareResult {
  assertImage(actual, "Actual");
  assertImage(expected, "Expected");
  const widthDelta = Math.abs(actual.width - expected.width);
  const heightDelta = Math.abs(actual.height - expected.height);
  const comparedWidth = Math.min(actual.width, expected.width);
  const comparedHeight = Math.min(actual.height, expected.height);
  const base = { widthDelta, heightDelta, comparedWidth, comparedHeight, diffPixels: 0, allowedDiffPixels: 0 };
  if (widthDelta > options.maxDimensionDelta || heightDelta > options.maxDimensionDelta) {
    return result({
      ...base,
      pass: false,
      reason: "dimension",
      message: `Map screenshot size differs by ${widthDelta}px in width and ${heightDelta}px in height, above the ${options.maxDimensionDelta}px limit. Expected ${expected.width}x${expected.height}, received ${actual.width}x${actual.height}.`,
    });
  }

  const diffPixels = pixelmatch(
    cropTopLeft(expected, comparedWidth, comparedHeight),
    cropTopLeft(actual, comparedWidth, comparedHeight),
    null,
    comparedWidth,
    comparedHeight,
    { threshold: options.colorThreshold },
  );
  const area = comparedWidth * comparedHeight;
  const ratioAllowance = options.maxDiffPixelRatio === undefined ? undefined : area * options.maxDiffPixelRatio;
  const pixelAllowance = options.maxDiffPixels;
  const allowedDiffPixels =
    ratioAllowance !== undefined && pixelAllowance !== undefined
      ? Math.min(ratioAllowance, pixelAllowance)
      : ratioAllowance ?? pixelAllowance ?? 0;
  const pass = diffPixels <= allowedDiffPixels;
  const sizeNote =
    widthDelta === 0 && heightDelta === 0
      ? ""
      : ` Compared the shared ${comparedWidth}x${comparedHeight} crop after a ${widthDelta}px by ${heightDelta}px size difference.`;
  return result({
    ...base,
    diffPixels,
    allowedDiffPixels,
    pass,
    reason: pass ? "match" : "pixels",
    message: pass
      ? `Map screenshot matches.${sizeNote}`
      : `Map screenshot differs by ${diffPixels} pixels (ratio ${(diffPixels / area).toFixed(4)} of the ${comparedWidth}x${comparedHeight} comparison); allowed ${allowedDiffPixels}.${sizeNote}`,
  });
}
