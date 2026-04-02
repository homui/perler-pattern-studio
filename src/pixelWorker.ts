import colorMap from "../colorMap.json";
import { CAM16_JMh } from "colorjs.io/fn";

type ColorRecord = {
  colorName: string;
  colorTitle: string;
  color: string;
};

type RawColorMap = Record<string, ColorRecord[]>;

type PaletteColor = {
  key: string;
  title: string;
  hex: string;
  rgb: [number, number, number];
  lab: [number, number, number];
  cam16ucs: [number, number, number];
};

type StylePresetId = "none" | "average" | "realistic" | "anime" | "portrait";
type MatchingAlgorithmId = "ciede2000" | "cam16ucs";
type SamplingMode = "average" | "edge-aware" | "dominant";
type StylePreset = {
  samplingMode: SamplingMode;
  edgeBoost: number;
  mergeBoost: number;
  cleanupBoost: number;
  targetColorRatio: number;
  minTargetColors: number;
};

type WorkerInitMessage = {
  type: "init";
};

type WorkerProcessMessage = {
  type: "process";
  bitmap: ImageBitmap;
  paletteTitle: string;
  targetWidth: number;
  stylePresetId: StylePresetId;
  matchingAlgorithmId: MatchingAlgorithmId;
  colorMergeStrength: number;
  cleanupStrength: number;
};

type WorkerRequest = WorkerInitMessage | WorkerProcessMessage;

type WorkerReadyMessage = {
  type: "ready";
  palettes: string[];
};

type WorkerSuccessMessage = {
  type: "result";
  width: number;
  height: number;
  previewBuffer: ArrayBuffer;
  cellIndexBuffer: ArrayBuffer;
  paletteEntries: Array<{
    key: string;
    title: string;
    hex: string;
  }>;
  stats: Array<{
    key: string;
    title: string;
    hex: string;
    count: number;
  }>;
  uniqueColorCount: number;
  elapsedMs: number;
};

type WorkerErrorMessage = {
  type: "error";
  message: string;
};

type WorkerResponse = WorkerReadyMessage | WorkerSuccessMessage | WorkerErrorMessage;

type SampleAccumulator = {
  linearR: Float64Array;
  linearG: Float64Array;
  linearB: Float64Array;
  weightSum: Float64Array;
  dominantBuckets: Map<number, Map<number, number>> | null;
};

const rawMap = colorMap as RawColorMap;
const paletteCache = buildPaletteCache(rawMap);
const paletteTitles = Array.from(paletteCache.keys()).sort((left, right) =>
  left.localeCompare(right, "zh-CN"),
);

const STYLE_PRESETS: Record<StylePresetId, StylePreset> = {
  none: {
    samplingMode: "average",
    edgeBoost: 0,
    mergeBoost: 0,
    cleanupBoost: 0,
    targetColorRatio: 1,
    minTargetColors: 0,
  },
  average: {
    samplingMode: "average",
    edgeBoost: 0,
    mergeBoost: 0,
    cleanupBoost: 0,
    targetColorRatio: 1,
    minTargetColors: 0,
  },
  realistic: {
    samplingMode: "edge-aware",
    edgeBoost: 1.4,
    mergeBoost: -10,
    cleanupBoost: -8,
    targetColorRatio: 0.96,
    minTargetColors: 18,
  },
  anime: {
    samplingMode: "dominant",
    edgeBoost: 0.9,
    mergeBoost: 10,
    cleanupBoost: 8,
    targetColorRatio: 0.74,
    minTargetColors: 12,
  },
  portrait: {
    samplingMode: "edge-aware",
    edgeBoost: 1.85,
    mergeBoost: 4,
    cleanupBoost: -2,
    targetColorRatio: 0.84,
    minTargetColors: 14,
  },
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "init") {
    const response: WorkerReadyMessage = {
      type: "ready",
      palettes: paletteTitles,
    };
    self.postMessage(response satisfies WorkerResponse);
    return;
  }

  if (message.type === "process") {
    processBitmap(message).catch((error: unknown) => {
      const response: WorkerErrorMessage = {
        type: "error",
        message: error instanceof Error ? error.message : "图片处理失败",
      };
      self.postMessage(response satisfies WorkerResponse);
    });
  }
};

async function processBitmap(message: WorkerProcessMessage): Promise<void> {
  const startedAt = performance.now();
  const { bitmap, paletteTitle } = message;
  const preset = STYLE_PRESETS[message.stylePresetId] ?? STYLE_PRESETS.average;
  const matchingAlgorithm = message.matchingAlgorithmId ?? "cam16ucs";
  const targetWidth = clamp(Math.round(message.targetWidth), 10, 200);
  const colorMergeStrength = clamp(Math.round(message.colorMergeStrength + preset.mergeBoost), 0, 100);
  const cleanupStrength = clamp(Math.round(message.cleanupStrength + preset.cleanupBoost), 0, 100);
  const palette = paletteCache.get(paletteTitle);

  if (!palette || palette.length === 0) {
    throw new Error(`未找到色表: ${paletteTitle}`);
  }

  const width = targetWidth;
  const height = clamp(Math.round((bitmap.height / bitmap.width) * width), 8, 256);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const context = canvas.getContext("2d", {
    alpha: true,
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error("无法创建离屏画布");
  }

  context.clearRect(0, 0, sourceWidth, sourceHeight);
  context.imageSmoothingEnabled = false;
  context.drawImage(bitmap, 0, 0, sourceWidth, sourceHeight);
  bitmap.close();

  const imageData = context.getImageData(0, 0, sourceWidth, sourceHeight);
  const source = imageData.data;
  const cellCount = width * height;
  const cellIndices = new Uint16Array(cellCount);
  cellIndices.fill(65535);
  const nearestCache = new Map<number, number>();
  const samples = createSampleAccumulator(cellCount, preset.samplingMode);

  for (let y = 0; y < sourceHeight; y += 1) {
    const targetY = Math.min(height - 1, Math.floor((y * height) / sourceHeight));

    for (let x = 0; x < sourceWidth; x += 1) {
      const targetX = Math.min(width - 1, Math.floor((x * width) / sourceWidth));
      const cellIndex = (targetY * width) + targetX;
      const offset = ((y * sourceWidth) + x) * 4;
      const alpha = source[offset + 3] / 255;

      if (alpha <= 0) {
        continue;
      }

      accumulateSample(samples, source, offset, sourceWidth, sourceHeight, x, y, cellIndex, alpha, preset);
    }
  }

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const representative = getRepresentativeColor(samples, cellIndex, preset.samplingMode);
    if (!representative) {
      continue;
    }

    const cacheKey = packRgb(representative[0], representative[1], representative[2]);
    let paletteIndex = nearestCache.get(cacheKey);

    if (paletteIndex === undefined) {
      const lab = rgbToLab(representative[0], representative[1], representative[2]);
      const cam16ucs = rgbToCam16Ucs(representative[0], representative[1], representative[2]);
      paletteIndex = findClosestPaletteIndex(lab, cam16ucs, palette, matchingAlgorithm);
      nearestCache.set(cacheKey, paletteIndex);
    }

    cellIndices[cellIndex] = paletteIndex;
  }

  const targetColorCount = computePresetTargetColorCount(preset, width, height, cellIndices, palette.length);
  if (targetColorCount !== null) {
    limitPaletteColors(cellIndices, palette, targetColorCount, matchingAlgorithm);
  }

  if (colorMergeStrength > 0) {
    mergeSimilarColors(cellIndices, width, height, palette, colorMergeStrength, matchingAlgorithm);
  }

  if (cleanupStrength > 0) {
    denoisePattern(cellIndices, width, height, palette, cleanupStrength, matchingAlgorithm);
  }

  const preview = new Uint8ClampedArray(width * height * 4);
  const colorCounts = new Uint32Array(palette.length);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const previewOffset = cellIndex * 4;
    const paletteIndex = cellIndices[cellIndex];

    if (paletteIndex === 65535) {
      preview[previewOffset] = 255;
      preview[previewOffset + 1] = 255;
      preview[previewOffset + 2] = 255;
      preview[previewOffset + 3] = 0;
      continue;
    }

    const match = palette[paletteIndex];
    preview[previewOffset] = match.rgb[0];
    preview[previewOffset + 1] = match.rgb[1];
    preview[previewOffset + 2] = match.rgb[2];
    preview[previewOffset + 3] = 255;
    colorCounts[paletteIndex] += 1;
  }

  const stats = Array.from(colorCounts, (count, index) => ({ count, index }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count)
    .map((entry) => {
      const match = palette[entry.index];
      return {
        key: match.key,
        title: match.title,
        hex: match.hex,
        count: entry.count,
      };
    });

  const response: WorkerSuccessMessage = {
    type: "result",
    width,
    height,
    previewBuffer: preview.buffer,
    cellIndexBuffer: cellIndices.buffer,
    paletteEntries: palette.map((entry) => ({
      key: entry.key,
      title: entry.title,
      hex: entry.hex,
    })),
    stats,
    uniqueColorCount: stats.length,
    elapsedMs: performance.now() - startedAt,
  };

  self.postMessage(
    response satisfies WorkerResponse,
    [response.previewBuffer, response.cellIndexBuffer],
  );
}

function createSampleAccumulator(cellCount: number, samplingMode: SamplingMode): SampleAccumulator {
  return {
    linearR: new Float64Array(cellCount),
    linearG: new Float64Array(cellCount),
    linearB: new Float64Array(cellCount),
    weightSum: new Float64Array(cellCount),
    dominantBuckets: samplingMode === "dominant" ? new Map<number, Map<number, number>>() : null,
  };
}

function accumulateSample(
  samples: SampleAccumulator,
  source: Uint8ClampedArray,
  offset: number,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  cellIndex: number,
  alpha: number,
  preset: StylePreset,
): void {
  const r = source[offset];
  const g = source[offset + 1];
  const b = source[offset + 2];

  if (preset.samplingMode === "dominant" && samples.dominantBuckets) {
    const bucketKey = rgbToBucket(r, g, b);
    const weight = alpha * (1 + estimateEdgeStrength(source, offset, sourceWidth, sourceHeight, x, y) * preset.edgeBoost);
    const cellBuckets = samples.dominantBuckets.get(cellIndex) ?? new Map<number, number>();
    if (!samples.dominantBuckets.has(cellIndex)) {
      samples.dominantBuckets.set(cellIndex, cellBuckets);
    }
    cellBuckets.set(bucketKey, (cellBuckets.get(bucketKey) || 0) + weight);
    return;
  }

  let weight = alpha;
  if (preset.samplingMode === "edge-aware") {
    weight *= 1 + (estimateEdgeStrength(source, offset, sourceWidth, sourceHeight, x, y) * preset.edgeBoost);
  }

  samples.linearR[cellIndex] += srgbToLinear(r) * weight;
  samples.linearG[cellIndex] += srgbToLinear(g) * weight;
  samples.linearB[cellIndex] += srgbToLinear(b) * weight;
  samples.weightSum[cellIndex] += weight;
}

function getRepresentativeColor(
  samples: SampleAccumulator,
  cellIndex: number,
  samplingMode: SamplingMode,
): [number, number, number] | null {
  if (samplingMode === "dominant" && samples.dominantBuckets) {
    const buckets = samples.dominantBuckets.get(cellIndex);
    if (!buckets || buckets.size === 0) {
      return null;
    }

    let bestBucket = 0;
    let bestWeight = Number.NEGATIVE_INFINITY;
    for (const [bucket, weight] of buckets.entries()) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestBucket = bucket;
      }
    }

    return bucketToRgb(bestBucket);
  }

  const weight = samples.weightSum[cellIndex];
  if (weight <= 0) {
    return null;
  }

  return [
    linearToSrgb8(samples.linearR[cellIndex] / weight),
    linearToSrgb8(samples.linearG[cellIndex] / weight),
    linearToSrgb8(samples.linearB[cellIndex] / weight),
  ];
}

function estimateEdgeStrength(
  source: Uint8ClampedArray,
  offset: number,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
): number {
  const currentLuma = rgbToLuma(source[offset], source[offset + 1], source[offset + 2]);
  let diff = 0;
  let count = 0;

  if (x + 1 < sourceWidth) {
    const rightOffset = offset + 4;
    diff += Math.abs(currentLuma - rgbToLuma(
      source[rightOffset],
      source[rightOffset + 1],
      source[rightOffset + 2],
    ));
    count += 1;
  }

  if (y + 1 < sourceHeight) {
    const downOffset = offset + (sourceWidth * 4);
    diff += Math.abs(currentLuma - rgbToLuma(
      source[downOffset],
      source[downOffset + 1],
      source[downOffset + 2],
    ));
    count += 1;
  }

  if (x > 0) {
    const leftOffset = offset - 4;
    diff += Math.abs(currentLuma - rgbToLuma(
      source[leftOffset],
      source[leftOffset + 1],
      source[leftOffset + 2],
    ));
    count += 1;
  }

  if (y > 0) {
    const upOffset = offset - (sourceWidth * 4);
    diff += Math.abs(currentLuma - rgbToLuma(
      source[upOffset],
      source[upOffset + 1],
      source[upOffset + 2],
    ));
    count += 1;
  }

  if (count === 0) {
    return 0;
  }

  return clamp((diff / count) / 96, 0, 1.5);
}

function computePresetTargetColorCount(
  preset: StylePreset,
  width: number,
  height: number,
  cellIndices: Uint16Array,
  paletteLength: number,
): number | null {
  if (preset.targetColorRatio >= 1) {
    return null;
  }

  const usageCounts = buildUsageCounts(cellIndices, paletteLength);
  const activeColors = countActiveColors(usageCounts);
  const gridMax = Math.max(width, height);
  const scaledMinimum = Math.max(
    preset.minTargetColors,
    gridMax <= 32 ? 10 : gridMax <= 48 ? 12 : gridMax <= 72 ? 16 : 20,
  );
  return clamp(Math.round(activeColors * preset.targetColorRatio), scaledMinimum, activeColors);
}

function limitPaletteColors(
  cellIndices: Uint16Array,
  palette: PaletteColor[],
  targetColorCount: number,
  matchingAlgorithm: MatchingAlgorithmId,
): void {
  const usageCounts = buildUsageCounts(cellIndices, palette.length);

  while (countActiveColors(usageCounts) > targetColorCount) {
    const activeColors = getActiveColors(usageCounts);
    const source = activeColors[0];
    const target = findClosestUsedPalette(source, usageCounts, palette, matchingAlgorithm);

    if (target === null) {
      break;
    }

    remapColorIndex(cellIndices, source, target);
    usageCounts[target] += usageCounts[source];
    usageCounts[source] = 0;
  }
}

function findClosestUsedPalette(
  source: number,
  usageCounts: Uint32Array,
  palette: PaletteColor[],
  matchingAlgorithm: MatchingAlgorithmId,
): number | null {
  let bestTarget: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let candidate = 0; candidate < usageCounts.length; candidate += 1) {
    if (candidate === source || usageCounts[candidate] === 0) {
      continue;
    }

    const distance = getPaletteDistance(palette, source, candidate, matchingAlgorithm);
    const usageBias = Math.log2(usageCounts[candidate] + 1) * 0.16;
    const score = distance - usageBias;
    if (score < bestScore) {
      bestScore = score;
      bestTarget = candidate;
    }
  }

  return bestTarget;
}

function mergeSimilarColors(
  cellIndices: Uint16Array,
  width: number,
  height: number,
  palette: PaletteColor[],
  colorMergeStrength: number,
  matchingAlgorithm: MatchingAlgorithmId,
): void {
  const cellCount = width * height;
  const usageCounts = buildUsageCounts(cellIndices, palette.length);
  const startingColors = countActiveColors(usageCounts);
  if (startingColors <= 1) {
    return;
  }

  const targetUnique = computeTargetUniqueCount(startingColors, width, height, colorMergeStrength);
  const rarePixelThreshold = computeRarePixelThreshold(cellCount, colorMergeStrength);
  const maxDistance = 3.6 + (colorMergeStrength * 0.048);

  for (;;) {
    const activeColors = getActiveColors(usageCounts);
    if (activeColors.length <= 1) {
      break;
    }

    let merged = false;
    for (let i = 0; i < activeColors.length; i += 1) {
      const source = activeColors[i];
      const sourceCount = usageCounts[source];
      const mustMerge = activeColors.length > targetUnique || sourceCount <= rarePixelThreshold;
      if (!mustMerge) {
        continue;
      }

      const bestTarget = findBestPaletteMergeTarget(source, usageCounts, palette, maxDistance, matchingAlgorithm);
      if (bestTarget === null) {
        continue;
      }

      remapColorIndex(cellIndices, source, bestTarget);
      usageCounts[bestTarget] += sourceCount;
      usageCounts[source] = 0;
      merged = true;
      break;
    }

    if (!merged) {
      break;
    }
  }
}

function denoisePattern(
  cellIndices: Uint16Array,
  width: number,
  height: number,
  palette: PaletteColor[],
  cleanupStrength: number,
  matchingAlgorithm: MatchingAlgorithmId,
): void {
  const cellCount = width * height;
  const usageCounts = buildUsageCounts(cellIndices, palette.length);

  const smallRegionThreshold = computeRegionThreshold(cleanupStrength, width, height);
  const mergeDeltaThreshold = 10 + (cleanupStrength * 0.22);
  const visited = new Uint8Array(cellCount);

  for (let start = 0; start < cellCount; start += 1) {
    const startColor = cellIndices[start];
    if (startColor === 65535 || visited[start] === 1) {
      continue;
    }

    const region = collectRegion(cellIndices, width, height, start, startColor, visited);
    if (region.length > smallRegionThreshold) {
      continue;
    }

    const mergeTarget = findBestMergeTarget(region, cellIndices, width, height, palette, usageCounts, mergeDeltaThreshold, matchingAlgorithm);
    if (mergeTarget === null) {
      continue;
    }

    for (let i = 0; i < region.length; i += 1) {
      cellIndices[region[i]] = mergeTarget;
    }

    usageCounts[mergeTarget] += region.length;
  }

  const smoothPasses = cleanupStrength >= 66 ? 2 : 1;
  for (let pass = 0; pass < smoothPasses; pass += 1) {
    smoothIsolatedPixels(cellIndices, width, height, palette, cleanupStrength, matchingAlgorithm);
  }
}

function buildUsageCounts(cellIndices: Uint16Array, paletteLength: number): Uint32Array {
  const usageCounts = new Uint32Array(paletteLength);
  for (let index = 0; index < cellIndices.length; index += 1) {
    const paletteIndex = cellIndices[index];
    if (paletteIndex !== 65535) {
      usageCounts[paletteIndex] += 1;
    }
  }

  return usageCounts;
}

function countActiveColors(usageCounts: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < usageCounts.length; index += 1) {
    if (usageCounts[index] > 0) {
      count += 1;
    }
  }

  return count;
}

function getActiveColors(usageCounts: Uint32Array): number[] {
  const result: number[] = [];
  for (let index = 0; index < usageCounts.length; index += 1) {
    if (usageCounts[index] > 0) {
      result.push(index);
    }
  }

  result.sort((left, right) => {
    const byUsage = usageCounts[left] - usageCounts[right];
    return byUsage !== 0 ? byUsage : left - right;
  });
  return result;
}

function computeTargetUniqueCount(
  startingColors: number,
  width: number,
  height: number,
  colorMergeStrength: number,
): number {
  const gridMax = Math.max(width, height);
  const floor = gridMax <= 32 ? 8 : gridMax <= 48 ? 10 : gridMax <= 72 ? 12 : 16;
  const ratio = 1 - (0.42 * (colorMergeStrength / 100));
  return clamp(Math.round(startingColors * ratio), floor, startingColors);
}

function computeRarePixelThreshold(cellCount: number, colorMergeStrength: number): number {
  const ratio = 0.004 + (colorMergeStrength * 0.00011);
  return Math.max(1, Math.round(cellCount * ratio));
}

function findBestPaletteMergeTarget(
  source: number,
  usageCounts: Uint32Array,
  palette: PaletteColor[],
  maxDistance: number,
  matchingAlgorithm: MatchingAlgorithmId,
): number | null {
  const sourceCount = usageCounts[source];
  let bestTarget: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let candidate = 0; candidate < usageCounts.length; candidate += 1) {
    if (candidate === source || usageCounts[candidate] === 0) {
      continue;
    }

    const candidateCount = usageCounts[candidate];
    if (candidateCount < sourceCount) {
      continue;
    }

    const distance = getPaletteDistance(palette, source, candidate, matchingAlgorithm);
    if (distance > maxDistance) {
      continue;
    }

    const lightnessGap = Math.abs(palette[source].lab[0] - palette[candidate].lab[0]);
    const usageBias = Math.log2(candidateCount + 1) * 0.32;
    const score = distance + (lightnessGap * 0.08) - usageBias;

    if (score < bestScore) {
      bestScore = score;
      bestTarget = candidate;
    }
  }

  return bestTarget;
}

function remapColorIndex(
  cellIndices: Uint16Array,
  source: number,
  target: number,
): void {
  for (let index = 0; index < cellIndices.length; index += 1) {
    if (cellIndices[index] === source) {
      cellIndices[index] = target;
    }
  }
}

function computeRegionThreshold(cleanupStrength: number, width: number, height: number): number {
  const base = Math.max(width, height) <= 32 ? 1 : Math.max(width, height) <= 48 ? 2 : Math.max(width, height) <= 72 ? 3 : 4;
  const extra = cleanupStrength >= 80 ? 2 : cleanupStrength >= 55 ? 1 : 0;
  return base + extra;
}

function collectRegion(
  cellIndices: Uint16Array,
  width: number,
  height: number,
  start: number,
  targetColor: number,
  visited: Uint8Array,
): number[] {
  const region: number[] = [];
  const stack = [start];
  visited[start] = 1;

  while (stack.length > 0) {
    const index = stack.pop() as number;
    region.push(index);
    const row = Math.floor(index / width);
    const col = index % width;

    if (row > 0) {
      const next = index - width;
      if (visited[next] === 0 && cellIndices[next] === targetColor) {
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (row < height - 1) {
      const next = index + width;
      if (visited[next] === 0 && cellIndices[next] === targetColor) {
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (col > 0) {
      const next = index - 1;
      if (visited[next] === 0 && cellIndices[next] === targetColor) {
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (col < width - 1) {
      const next = index + 1;
      if (visited[next] === 0 && cellIndices[next] === targetColor) {
        visited[next] = 1;
        stack.push(next);
      }
    }
  }

  return region;
}

function findBestMergeTarget(
  region: number[],
  cellIndices: Uint16Array,
  width: number,
  height: number,
  palette: PaletteColor[],
  usageCounts: Uint32Array,
  mergeDeltaThreshold: number,
  matchingAlgorithm: MatchingAlgorithmId,
): number | null {
  const sourceColor = cellIndices[region[0]];
  const neighborAdjacency = new Map<number, number>();

  for (let i = 0; i < region.length; i += 1) {
    const index = region[i];
    const row = Math.floor(index / width);
    const col = index % width;

    if (row > 0) registerNeighbor(index - width, sourceColor, cellIndices, neighborAdjacency);
    if (row < height - 1) registerNeighbor(index + width, sourceColor, cellIndices, neighborAdjacency);
    if (col > 0) registerNeighbor(index - 1, sourceColor, cellIndices, neighborAdjacency);
    if (col < width - 1) registerNeighbor(index + 1, sourceColor, cellIndices, neighborAdjacency);
  }

  let bestTarget: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const [candidate, adjacency] of neighborAdjacency.entries()) {
    const distance = getPaletteDistance(palette, sourceColor, candidate, matchingAlgorithm);
    if (distance > mergeDeltaThreshold && region.length > 1) {
      continue;
    }

    const usageBoost = Math.log2((usageCounts[candidate] || 1) + 1);
    const adjacencyBoost = adjacency * 7.5;
    const contrastPenalty = distance * 1.25;
    const score = adjacencyBoost + usageBoost - contrastPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestTarget = candidate;
    }
  }

  return bestTarget;
}

function registerNeighbor(
  neighborIndex: number,
  sourceColor: number,
  cellIndices: Uint16Array,
  adjacency: Map<number, number>,
): void {
  const neighborColor = cellIndices[neighborIndex];
  if (neighborColor === 65535 || neighborColor === sourceColor) {
    return;
  }

  adjacency.set(neighborColor, (adjacency.get(neighborColor) || 0) + 1);
}

function smoothIsolatedPixels(
  cellIndices: Uint16Array,
  width: number,
  height: number,
  palette: PaletteColor[],
  cleanupStrength: number,
  matchingAlgorithm: MatchingAlgorithmId,
): void {
  const snapshot = new Uint16Array(cellIndices);
  const replacementThreshold = cleanupStrength >= 70 ? 4 : 5;
  const distanceThreshold = 8 + (cleanupStrength * 0.24);

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = (row * width) + col;
      const currentColor = snapshot[index];
      if (currentColor === 65535) {
        continue;
      }

      const neighborCounts = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const nextRow = row + dy;
          const nextCol = col + dx;
          if (nextRow < 0 || nextRow >= height || nextCol < 0 || nextCol >= width) {
            continue;
          }

          const neighborColor = snapshot[(nextRow * width) + nextCol];
          if (neighborColor === 65535) {
            continue;
          }

          neighborCounts.set(neighborColor, (neighborCounts.get(neighborColor) || 0) + 1);
        }
      }

      let bestNeighbor: number | null = null;
      let bestCount = 0;
      for (const [neighborColor, count] of neighborCounts.entries()) {
        if (neighborColor === currentColor) {
          continue;
        }

        if (count > bestCount) {
          bestCount = count;
          bestNeighbor = neighborColor;
        }
      }

      if (bestNeighbor === null || bestCount < replacementThreshold) {
        continue;
      }

      const currentSupport = neighborCounts.get(currentColor) || 0;
      if (currentSupport >= 3) {
        continue;
      }

      const distance = getPaletteDistance(palette, currentColor, bestNeighbor, matchingAlgorithm);
      if (distance > distanceThreshold) {
        continue;
      }

      cellIndices[index] = bestNeighbor;
    }
  }
}

function buildPaletteCache(map: RawColorMap): Map<string, PaletteColor[]> {
  const result = new Map<string, PaletteColor[]>();

  for (const [hex, records] of Object.entries(map)) {
    const rgb = hexToRgb(hex);
    if (!rgb) {
      continue;
    }

    const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
    const cam16ucs = rgbToCam16Ucs(rgb[0], rgb[1], rgb[2]);

    for (const record of records) {
      const title = record.colorTitle.trim();
      if (!title) {
        continue;
      }

      const current = result.get(title) ?? [];
      if (!result.has(title)) {
        result.set(title, current);
      }

      if (current.some((item) => item.hex === hex)) {
        continue;
      }

      current.push({
        key: record.colorName,
        title,
        hex: hex.toUpperCase(),
        rgb,
        lab,
        cam16ucs,
      });
    }
  }

  return result;
}

function findClosestPaletteIndex(
  targetLab: [number, number, number],
  targetCam16Ucs: [number, number, number],
  palette: PaletteColor[],
  matchingAlgorithm: MatchingAlgorithmId,
): number {
  let minDistance = Number.POSITIVE_INFINITY;
  let minIndex = 0;

  for (let index = 0; index < palette.length; index += 1) {
    const distance = matchingAlgorithm === "cam16ucs"
      ? euclideanDistance3(targetCam16Ucs, palette[index].cam16ucs)
      : deltaE2000(targetLab, palette[index].lab);
    if (distance < minDistance) {
      minDistance = distance;
      minIndex = index;
      if (distance === 0) {
        break;
      }
    }
  }

  return minIndex;
}

function getPaletteDistance(
  palette: PaletteColor[],
  leftIndex: number,
  rightIndex: number,
  matchingAlgorithm: MatchingAlgorithmId,
): number {
  return matchingAlgorithm === "cam16ucs"
    ? euclideanDistance3(palette[leftIndex].cam16ucs, palette[rightIndex].cam16ucs)
    : deltaE2000(palette[leftIndex].lab, palette[rightIndex].lab);
}

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function euclideanDistance3(
  left: [number, number, number],
  right: [number, number, number],
): number {
  const delta0 = left[0] - right[0];
  const delta1 = left[1] - right[1];
  const delta2 = left[2] - right[2];
  return Math.sqrt((delta0 * delta0) + (delta1 * delta1) + (delta2 * delta2));
}

function rgbToCam16Ucs(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = rgbToXyz(r, g, b);
  const cam16 = CAM16_JMh.fromBase([x / 100, y / 100, z / 100]) as [number, number, number | null];
  const j = cam16[0];
  const m = cam16[1];
  const hue = Number.isFinite(cam16[2] as number) ? (cam16[2] as number) : 0;
  const jPrime = (1.7 * j) / (1 + (0.007 * j));
  const mPrime = Math.log(1 + (0.0228 * Math.max(m, 0))) / 0.0228;
  const radians = toRadians(hue);

  return [
    jPrime,
    mPrime * Math.cos(radians),
    mPrime * Math.sin(radians),
  ];
}

function rgbToBucket(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function bucketToRgb(bucket: number): [number, number, number] {
  return [
    (((bucket >> 10) & 31) << 3) + 4,
    (((bucket >> 5) & 31) << 3) + 4,
    ((bucket & 31) << 3) + 4,
  ];
}

function rgbToLuma(r: number, g: number, b: number): number {
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

function deltaE2000(left: [number, number, number], right: [number, number, number]): number {
  const [l1, a1, b1] = left;
  const [l2, a2, b2] = right;

  const c1 = Math.sqrt((a1 * a1) + (b1 * b1));
  const c2 = Math.sqrt((a2 * a2) + (b2 * b2));
  const avgC = (c1 + c2) / 2;

  const pow25To7 = 6103515625;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + pow25To7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.sqrt((a1Prime * a1Prime) + (b1 * b1));
  const c2Prime = Math.sqrt((a2Prime * a2Prime) + (b2 * b2));
  const avgCPrime = (c1Prime + c2Prime) / 2;

  const h1Prime = toHueDegrees(b1, a1Prime);
  const h2Prime = toHueDegrees(b2, a2Prime);

  const deltaLPrime = l2 - l1;
  const deltaCPrime = c2Prime - c1Prime;
  const deltaHPrime = computeDeltaHue(c1Prime, c2Prime, h1Prime, h2Prime);
  const deltaBigHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(toRadians(deltaHPrime / 2));

  const avgLPrime = (l1 + l2) / 2;
  const avgHuePrime = computeAverageHue(c1Prime, c2Prime, h1Prime, h2Prime);

  const t =
    1
    - (0.17 * Math.cos(toRadians(avgHuePrime - 30)))
    + (0.24 * Math.cos(toRadians(2 * avgHuePrime)))
    + (0.32 * Math.cos(toRadians((3 * avgHuePrime) + 6)))
    - (0.2 * Math.cos(toRadians((4 * avgHuePrime) - 63)));

  const deltaTheta = 30 * Math.exp(-Math.pow((avgHuePrime - 275) / 25, 2));
  const rc = 2 * Math.sqrt(Math.pow(avgCPrime, 7) / (Math.pow(avgCPrime, 7) + pow25To7));
  const sl = 1 + ((0.015 * Math.pow(avgLPrime - 50, 2)) / Math.sqrt(20 + Math.pow(avgLPrime - 50, 2)));
  const sc = 1 + (0.045 * avgCPrime);
  const sh = 1 + (0.015 * avgCPrime * t);
  const rt = -Math.sin(toRadians(2 * deltaTheta)) * rc;

  const lTerm = deltaLPrime / sl;
  const cTerm = deltaCPrime / sc;
  const hTerm = deltaBigHPrime / sh;

  return Math.sqrt(
    (lTerm * lTerm)
      + (cTerm * cTerm)
      + (hTerm * hTerm)
      + (rt * cTerm * hTerm),
  );
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(normalized);
  if (!match) {
    return null;
  }

  const value = match[1];
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = rgbToXyz(r, g, b);

  const whiteX = 95.047;
  const whiteY = 100;
  const whiteZ = 108.883;

  const fx = xyzPivot(x / whiteX);
  const fy = xyzPivot(y / whiteY);
  const fz = xyzPivot(z / whiteZ);

  return [
    (116 * fy) - 16,
    500 * (fx - fy),
    200 * (fy - fz),
  ];
}

function srgbToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function linearToSrgb8(value: number): number {
  const normalized = clamp(value, 0, 1);
  const srgb = normalized <= 0.0031308
    ? normalized * 12.92
    : (1.055 * Math.pow(normalized, 1 / 2.4)) - 0.055;

  return Math.round(clamp(srgb * 255, 0, 255));
}

function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const sr = rgbPivot(r / 255);
  const sg = rgbPivot(g / 255);
  const sb = rgbPivot(b / 255);

  return [
    (sr * 0.4124 + sg * 0.3576 + sb * 0.1805) * 100,
    (sr * 0.2126 + sg * 0.7152 + sb * 0.0722) * 100,
    (sr * 0.0193 + sg * 0.1192 + sb * 0.9505) * 100,
  ];
}

function rgbPivot(value: number): number {
  return value > 0.04045
    ? Math.pow((value + 0.055) / 1.055, 2.4)
    : value / 12.92;
}

function xyzPivot(value: number): number {
  return value > 0.008856
    ? Math.cbrt(value)
    : (7.787 * value) + (16 / 116);
}

function toHueDegrees(b: number, aPrime: number): number {
  if (aPrime === 0 && b === 0) {
    return 0;
  }

  const hue = Math.atan2(b, aPrime) * (180 / Math.PI);
  return hue >= 0 ? hue : hue + 360;
}

function computeDeltaHue(
  c1Prime: number,
  c2Prime: number,
  h1Prime: number,
  h2Prime: number,
): number {
  if (c1Prime === 0 || c2Prime === 0) {
    return 0;
  }

  const difference = h2Prime - h1Prime;
  if (Math.abs(difference) <= 180) {
    return difference;
  }

  if (difference > 180) {
    return difference - 360;
  }

  return difference + 360;
}

function computeAverageHue(
  c1Prime: number,
  c2Prime: number,
  h1Prime: number,
  h2Prime: number,
): number {
  if (c1Prime === 0 || c2Prime === 0) {
    return h1Prime + h2Prime;
  }

  const hueDiff = Math.abs(h1Prime - h2Prime);
  if (hueDiff <= 180) {
    return (h1Prime + h2Prime) / 2;
  }

  if ((h1Prime + h2Prime) < 360) {
    return (h1Prime + h2Prime + 360) / 2;
  }

  return (h1Prime + h2Prime - 360) / 2;
}

function toRadians(value: number): number {
  return value * (Math.PI / 180);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
