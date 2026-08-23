import type { Candle, ScanResult } from "./types";

export interface ChartAttachment {
  filename: string;
  contentType: "image/png";
  bytes: Uint8Array;
}

interface ChartPoint {
  x: number;
  y: number;
}

interface PriceMarker {
  readonly lineY: number;
  readonly color: readonly number[];
  readonly label: string;
}

const WIDTH = 640;
const HEIGHT = 340;
const LEFT = 54;
const RIGHT = 98;
const TOP = 42;
const BOTTOM = 40;
const MAX_CANDLES = 48;
const MINIMUM_CHART_CANDLES = 2;
const PLOT_BACKGROUND = [15, 23, 42, 255] as const;
const GRID_COLOR = [71, 85, 105, 72] as const;
const GRID_ACCENT_COLOR = [148, 163, 184, 76] as const;
const BULLISH_COLOR = [45, 212, 191, 255] as const;
const BEARISH_COLOR = [251, 113, 133, 255] as const;
const VWAP_COLOR = [96, 165, 250, 230] as const;
const LATEST_PRICE_COLOR = [250, 204, 21, 235] as const;
const SESSION_LEVEL_COLOR = [148, 163, 184, 150] as const;
const TARGET_COLOR = [34, 197, 94, 230] as const;
const INVALIDATION_COLOR = [248, 113, 113, 230] as const;
const ENTRY_COLOR = [251, 191, 36, 230] as const;
const LEGEND_TEXT_COLOR = [226, 232, 240, 245] as const;
const MARKER_TEXT_COLOR = [248, 250, 252, 245] as const;
const GLYPH_WIDTH = 5;
const GLYPH_GAP = 1;

/**
 * Render the market brief as a compact price-location chart for Discord.
 */
export async function renderMarketBriefChart(
  result: ScanResult,
  candles: readonly Candle[],
): Promise<ChartAttachment | undefined> {
  const chartCandles = candles.slice(-MAX_CANDLES);
  if (chartCandles.length < MINIMUM_CHART_CANDLES) {
    return undefined;
  }

  const vwapSeries = cumulativeVwapSeries(chartCandles);
  const opportunity = result.signal ?? result.watch;
  const prices = [
    ...chartCandles.flatMap((candle) => [candle.high, candle.low]),
    ...vwapSeries.filter(isFiniteNumber),
    result.latestPrice,
    result.sessionHigh,
    result.sessionLow,
    opportunity?.entryLow,
    opportunity?.entryHigh,
    opportunity?.invalidation,
    opportunity?.target,
  ].filter(isFiniteNumber);
  if (prices.length === 0) {
    return undefined;
  }

  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);
  const padding = Math.max((priceMax - priceMin) * 0.12, priceMax * 0.002, 1);
  const scaleMin = priceMin - padding;
  const scaleMax = priceMax + padding;
  const image = new RasterImage(WIDTH, HEIGHT);
  const toX = (index: number): number =>
    LEFT +
    (index / Math.max(chartCandles.length - 1, 1)) *
      (WIDTH - LEFT - RIGHT);
  const toY = (price: number): number =>
    TOP +
    ((scaleMax - price) / Math.max(scaleMax - scaleMin, 1)) *
      (HEIGHT - TOP - BOTTOM);

  drawPanel(image);
  drawGrid(image);
  drawChartLegend(image, opportunity !== null);
  drawCandles(image, chartCandles, toX, toY);
  drawLine(image, seriesToPoints(vwapSeries, toX, toY), VWAP_COLOR, 2);
  const markers = [
    ...drawSessionReferenceLines(image, result, toY),
    ...drawSignalReferenceLines(image, opportunity, toY),
    ...drawLatestPriceMarker(image, result, toX(chartCandles.length - 1), toY),
  ];
  drawRightMarkers(image, markers);

  return {
    filename: chartFilename(result.market),
    contentType: "image/png",
    bytes: await encodeCompressedPng(
      image.width,
      image.height,
      image.pixels,
    ),
  };
}

function drawPanel(image: RasterImage): void {
  drawPlotGradient(image);
  image.fillRect(
    LEFT,
    TOP,
    WIDTH - LEFT - RIGHT,
    HEIGHT - TOP - BOTTOM,
    PLOT_BACKGROUND,
  );
  image.fillRect(LEFT, TOP, WIDTH - LEFT - RIGHT, 1, [148, 163, 184, 70]);
  image.fillRect(
    LEFT,
    HEIGHT - BOTTOM,
    WIDTH - LEFT - RIGHT,
    1,
    [15, 23, 42, 255],
  );
  image.fillRect(LEFT, TOP, 1, HEIGHT - TOP - BOTTOM, [148, 163, 184, 45]);
  image.fillRect(
    WIDTH - RIGHT,
    TOP,
    1,
    HEIGHT - TOP - BOTTOM,
    [148, 163, 184, 45],
  );
}

function drawPlotGradient(image: RasterImage): void {
  for (let y = 0; y < HEIGHT; y += 1) {
    const ratio = y / Math.max(HEIGHT - 1, 1);
    const color = [
      10 + Math.round(ratio * 5),
      16 + Math.round(ratio * 9),
      31 + Math.round(ratio * 11),
      255,
    ];
    if (y < TOP || y >= HEIGHT - BOTTOM) {
      image.fillRect(0, y, WIDTH, 1, color);
      continue;
    }
    image.fillRect(0, y, LEFT, 1, color);
    image.fillRect(WIDTH - RIGHT, y, RIGHT, 1, color);
  }
}

function drawGrid(image: RasterImage): void {
  for (let index = 0; index <= 4; index += 1) {
    const y = TOP + (index / 4) * (HEIGHT - TOP - BOTTOM);
    const color = index === 0 || index === 4 ? GRID_ACCENT_COLOR : GRID_COLOR;
    drawHorizontalLine(image, y, color, 1);
  }
  for (let index = 1; index <= 3; index += 1) {
    const x = LEFT + (index / 4) * (WIDTH - LEFT - RIGHT);
    image.fillRect(x, TOP, 1, HEIGHT - TOP - BOTTOM, [71, 85, 105, 38]);
  }
}

function drawChartLegend(image: RasterImage, hasOpportunity: boolean): void {
  let x = LEFT;
  const y = 20;
  const entries = [
    { color: VWAP_COLOR, label: "VWAP" },
    { color: LATEST_PRICE_COLOR, label: "LAST" },
    { color: SESSION_LEVEL_COLOR, label: "SESSION" },
    ...(hasOpportunity
      ? [
          { color: ENTRY_COLOR, label: "ENTRY" },
          { color: INVALIDATION_COLOR, label: "STOP" },
          { color: TARGET_COLOR, label: "TARGET" },
        ]
      : []),
  ];

  entries.forEach((entry) => {
    drawLegendLineSwatch(image, x, y + 7, entry.color);
    drawText(image, entry.label, x + 30, y, LEGEND_TEXT_COLOR, 1);
    x += 30 + measureText(entry.label, 1) + 16;
  });
}

function drawLegendLineSwatch(
  image: RasterImage,
  x: number,
  y: number,
  color: readonly number[],
): void {
  drawDashedHorizontalSegment(image, y, x, x + 20, color, 2);
}

function drawCandles(
  image: RasterImage,
  candles: readonly Candle[],
  toX: (index: number) => number,
  toY: (price: number) => number,
): void {
  const spacing = (WIDTH - LEFT - RIGHT) / Math.max(candles.length - 1, 1);
  const candleWidth = Math.max(4, Math.min(10, Math.floor(spacing * 0.55)));
  candles.forEach((candle, index) => {
    const x = Math.round(toX(index));
    const highY = Math.round(toY(candle.high));
    const lowY = Math.round(toY(candle.low));
    const openY = Math.round(toY(candle.open));
    const closeY = Math.round(toY(candle.close));
    const color = candle.close >= candle.open ? BULLISH_COLOR : BEARISH_COLOR;
    image.fillRect(x - 1, highY, 2, Math.max(lowY - highY, 1), color);
    image.fillRect(
      x - Math.floor(candleWidth / 2),
      Math.min(openY, closeY),
      candleWidth,
      Math.max(Math.abs(closeY - openY), 2),
      color,
    );
  });
}

function drawSessionReferenceLines(
  image: RasterImage,
  result: ScanResult,
  toY: (price: number) => number,
): PriceMarker[] {
  const markers: PriceMarker[] = [];
  if (result.sessionHigh !== null) {
    const lineY = toY(result.sessionHigh);
    drawDashedHorizontalSegment(
      image,
      lineY,
      LEFT,
      WIDTH - RIGHT,
      SESSION_LEVEL_COLOR,
      1,
    );
    markers.push({ lineY, color: SESSION_LEVEL_COLOR, label: "HIGH" });
  }
  if (result.sessionLow !== null) {
    const lineY = toY(result.sessionLow);
    drawDashedHorizontalSegment(
      image,
      lineY,
      LEFT,
      WIDTH - RIGHT,
      SESSION_LEVEL_COLOR,
      1,
    );
    markers.push({ lineY, color: SESSION_LEVEL_COLOR, label: "LOW" });
  }
  return markers;
}

function drawSignalReferenceLines(
  image: RasterImage,
  opportunity: ScanResult["signal"],
  toY: (price: number) => number,
): PriceMarker[] {
  if (opportunity === null) {
    return [];
  }
  const markers: PriceMarker[] = [];
  const entryLowY = toY(opportunity.entryLow);
  const entryHighY = toY(opportunity.entryHigh);
  const invalidationY = toY(opportunity.invalidation);
  const targetY = toY(opportunity.target);
  drawDashedHorizontalSegment(
    image,
    entryLowY,
    LEFT + 120,
    WIDTH - RIGHT,
    ENTRY_COLOR,
    2,
  );
  drawDashedHorizontalSegment(
    image,
    entryHighY,
    LEFT + 120,
    WIDTH - RIGHT,
    ENTRY_COLOR,
    2,
  );
  markers.push({
    lineY: (entryLowY + entryHighY) / 2,
    color: ENTRY_COLOR,
    label: "ENTRY",
  });
  drawDashedHorizontalSegment(
    image,
    invalidationY,
    LEFT + 220,
    WIDTH - RIGHT,
    INVALIDATION_COLOR,
    2,
  );
  markers.push({
    lineY: invalidationY,
    color: INVALIDATION_COLOR,
    label: "STOP",
  });
  drawDashedHorizontalSegment(
    image,
    targetY,
    LEFT + 220,
    WIDTH - RIGHT,
    TARGET_COLOR,
    2,
  );
  markers.push({ lineY: targetY, color: TARGET_COLOR, label: "TARGET" });
  return markers;
}

function drawLatestPriceMarker(
  image: RasterImage,
  result: ScanResult,
  latestX: number,
  toY: (price: number) => number,
): PriceMarker[] {
  if (result.latestPrice === null) {
    return [];
  }
  const latestY = toY(result.latestPrice);
  drawDashedHorizontalSegment(
    image,
    latestY,
    LEFT + 260,
    WIDTH - RIGHT,
    LATEST_PRICE_COLOR,
    2,
  );
  drawFocusDot(image, latestX, latestY, LATEST_PRICE_COLOR);
  return [{ lineY: latestY, color: LATEST_PRICE_COLOR, label: "LAST" }];
}

function drawHorizontalLine(
  image: RasterImage,
  y: number,
  color: readonly number[],
  thickness: number,
): void {
  image.fillRect(LEFT, Math.round(y), WIDTH - LEFT - RIGHT, thickness, color);
}

function drawHorizontalSegment(
  image: RasterImage,
  y: number,
  startX: number,
  endX: number,
  color: readonly number[],
  thickness: number,
): void {
  image.fillRect(startX, Math.round(y), endX - startX, thickness, color);
}

function drawDashedHorizontalSegment(
  image: RasterImage,
  y: number,
  startX: number,
  endX: number,
  color: readonly number[],
  thickness: number,
): void {
  const roundedY = Math.round(y - (thickness - 1) / 2);
  const roundedStartX = Math.round(startX);
  const roundedEndX = Math.round(endX);
  const dashWidth = 18;
  const gapWidth = 8;
  for (let x = roundedStartX; x < roundedEndX; x += dashWidth + gapWidth) {
    image.fillRect(
      x,
      roundedY,
      Math.min(dashWidth, roundedEndX - x),
      thickness,
      color,
    );
  }
}

function drawRightMarker(
  image: RasterImage,
  marker: PriceMarker,
  labelY: number,
  color: readonly number[],
): void {
  const markerY = Math.round(labelY) - 6;
  const markerX = WIDTH - RIGHT + 8;
  const markerWidth = Math.max(52, measureText(marker.label, 1) + 18);
  drawHorizontalSegment(image, marker.lineY, WIDTH - RIGHT, markerX, color, 2);
  image.fillRect(markerX, markerY, markerWidth, 13, [2, 6, 23, 215]);
  image.fillRect(markerX, markerY, 5, 13, color);
  drawText(image, marker.label, markerX + 9, markerY + 3, MARKER_TEXT_COLOR, 1);
}

function drawRightMarkers(
  image: RasterImage,
  markers: readonly PriceMarker[],
): void {
  resolveMarkerLabelPositions(markers).forEach(({ marker, labelY }) => {
    drawRightMarker(image, marker, labelY, marker.color);
  });
}

function resolveMarkerLabelPositions(
  markers: readonly PriceMarker[],
): Array<{ marker: PriceMarker; labelY: number }> {
  const sortedMarkers = markers
    .slice()
    .sort((leftMarker, rightMarker) => leftMarker.lineY - rightMarker.lineY);
  const minimumGap = 16;
  const topLimit = TOP + 7;
  const bottomLimit = HEIGHT - BOTTOM - 7;
  const positions = sortedMarkers.map((marker) => ({
    marker,
    labelY: clamp(marker.lineY, topLimit, bottomLimit),
  }));

  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1];
    const current = positions[index];
    if (previous !== undefined && current !== undefined) {
      current.labelY = Math.max(current.labelY, previous.labelY + minimumGap);
    }
  }

  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const current = positions[index];
    const next = positions[index + 1];
    if (current === undefined) {
      continue;
    }
    current.labelY = Math.min(current.labelY, bottomLimit);
    if (next !== undefined) {
      current.labelY = Math.min(current.labelY, next.labelY - minimumGap);
    }
    current.labelY = Math.max(current.labelY, topLimit);
  }

  return positions;
}

function drawFocusDot(
  image: RasterImage,
  x: number,
  y: number,
  color: readonly number[],
): void {
  image.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8, [2, 6, 23, 210]);
  image.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4, color);
}

function drawLine(
  image: RasterImage,
  points: readonly ChartPoint[],
  color: readonly number[],
  thickness: number,
): void {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous !== undefined && current !== undefined) {
      drawSegment(image, previous, current, color, thickness);
    }
  }
}

function drawSegment(
  image: RasterImage,
  start: ChartPoint,
  end: ChartPoint,
  color: readonly number[],
  thickness: number,
): void {
  const steps = Math.ceil(
    Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)),
  );
  for (let step = 0; step <= steps; step += 1) {
    const ratio = steps === 0 ? 0 : step / steps;
    const x = Math.round(start.x + (end.x - start.x) * ratio);
    const y = Math.round(start.y + (end.y - start.y) * ratio);
    drawCenteredPoint(image, x, y, thickness, color);
  }
}

function drawCenteredPoint(
  image: RasterImage,
  x: number,
  y: number,
  thickness: number,
  color: readonly number[],
): void {
  const offset = Math.floor(thickness / 2);
  image.fillRect(x - offset, y - offset, thickness, thickness, color);
}

function seriesToPoints(
  values: ReadonlyArray<number | undefined>,
  toX: (index: number) => number,
  toY: (price: number) => number,
): ChartPoint[] {
  return values.flatMap((value, index) =>
    value === undefined ? [] : [{ x: toX(index), y: toY(value) }],
  );
}

function cumulativeVwapSeries(
  candles: readonly Candle[],
): Array<number | undefined> {
  let notional = 0;
  let volume = 0;
  return candles.map((candle) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    notional += typicalPrice * candle.volume;
    volume += candle.volume;
    return volume > 0 ? notional / volume : undefined;
  });
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function chartFilename(market: string): string {
  const symbol = market.includes(":") ? market.split(":").at(-1) : market;
  const safeSymbol = (symbol ?? "market").replace(/[^a-z0-9_-]/gi, "-");
  return `${safeSymbol}-brief-chart.png`;
}

function drawText(
  image: RasterImage,
  text: string,
  left: number,
  top: number,
  color: readonly number[],
  scale: number,
): void {
  let x = Math.round(left);
  const upperText = text.toUpperCase();
  for (const character of upperText) {
    drawGlyph(image, character, x, Math.round(top), color, scale);
    x += (GLYPH_WIDTH + GLYPH_GAP) * scale;
  }
}

function drawGlyph(
  image: RasterImage,
  character: string,
  left: number,
  top: number,
  color: readonly number[],
  scale: number,
): void {
  const rows = FONT[character] ?? BLANK_GLYPH;
  rows.forEach((row, rowIndex) => {
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      if (row[columnIndex] === "1") {
        image.fillRect(
          left + columnIndex * scale,
          top + rowIndex * scale,
          scale,
          scale,
          color,
        );
      }
    }
  });
}

function measureText(text: string, scale: number): number {
  if (text.length === 0) {
    return 0;
  }
  return (
    text.length * GLYPH_WIDTH * scale +
    Math.max(text.length - 1, 0) * GLYPH_GAP * scale
  );
}

const BLANK_GLYPH = [
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
] as const;

const FONT: Record<string, readonly string[]> = {
  " ": BLANK_GLYPH,
  A: [
    "01110",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ],
  E: [
    "11111",
    "10000",
    "10000",
    "11110",
    "10000",
    "10000",
    "11111",
  ],
  G: [
    "01111",
    "10000",
    "10000",
    "10011",
    "10001",
    "10001",
    "01111",
  ],
  H: [
    "10001",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ],
  I: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "11111",
  ],
  L: [
    "10000",
    "10000",
    "10000",
    "10000",
    "10000",
    "10000",
    "11111",
  ],
  N: [
    "10001",
    "11001",
    "10101",
    "10011",
    "10001",
    "10001",
    "10001",
  ],
  O: [
    "01110",
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "01110",
  ],
  P: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10000",
    "10000",
    "10000",
  ],
  R: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10100",
    "10010",
    "10001",
  ],
  S: [
    "01111",
    "10000",
    "10000",
    "01110",
    "00001",
    "00001",
    "11110",
  ],
  T: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
  ],
  V: [
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "01010",
    "00100",
  ],
  W: [
    "10001",
    "10001",
    "10001",
    "10101",
    "10101",
    "11011",
    "10001",
  ],
  Y: [
    "10001",
    "10001",
    "01010",
    "00100",
    "00100",
    "00100",
    "00100",
  ],
};

class RasterImage {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height * 4);
  }

  fillRect(
    left: number,
    top: number,
    width: number,
    height: number,
    color: readonly number[],
  ): void {
    const startX = clamp(Math.floor(left), 0, this.width);
    const startY = clamp(Math.floor(top), 0, this.height);
    const endX = clamp(Math.ceil(left + width), 0, this.width);
    const endY = clamp(Math.ceil(top + height), 0, this.height);
    if ((color[3] ?? 255) >= 255) {
      this.fillOpaqueRect(startX, startY, endX, endY, color);
      return;
    }
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        this.blendPixel(x, y, color);
      }
    }
  }

  private fillOpaqueRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    color: readonly number[],
  ): void {
    const red = color[0] ?? 0;
    const green = color[1] ?? 0;
    const blue = color[2] ?? 0;
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * this.width + x) * 4;
        this.pixels[offset] = red;
        this.pixels[offset + 1] = green;
        this.pixels[offset + 2] = blue;
        this.pixels[offset + 3] = 255;
      }
    }
  }

  private blendPixel(x: number, y: number, color: readonly number[]): void {
    const offset = (y * this.width + x) * 4;
    const alpha = (color[3] ?? 255) / 255;
    const inverseAlpha = 1 - alpha;
    const red = this.pixels[offset] ?? 0;
    const green = this.pixels[offset + 1] ?? 0;
    const blue = this.pixels[offset + 2] ?? 0;
    this.pixels[offset] = Math.round(
      (color[0] ?? 0) * alpha + red * inverseAlpha,
    );
    this.pixels[offset + 1] = Math.round(
      (color[1] ?? 0) * alpha + green * inverseAlpha,
    );
    this.pixels[offset + 2] = Math.round(
      (color[2] ?? 0) * alpha + blue * inverseAlpha,
    );
    this.pixels[offset + 3] = 255;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

async function encodeCompressedPng(
  width: number,
  height: number,
  rgbaPixels: Uint8Array,
): Promise<Uint8Array> {
  const raw = buildPngScanlines(width, height, rgbaPixels);
  const compressionStream = new CompressionStream("deflate");
  const writer = compressionStream.writable.getWriter();
  const compressedBytesPromise = new Response(
    compressionStream.readable,
  ).arrayBuffer();
  await writer.write(raw);
  await writer.close();
  const compressedBytes = new Uint8Array(await compressedBytesPromise);

  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdrBytes(width, height)),
    pngChunk("IDAT", compressedBytes),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function buildPngScanlines(
  width: number,
  height: number,
  rgbaPixels: Uint8Array,
): Uint8Array {
  const scanlineWidth = width * 4 + 1;
  const raw = new Uint8Array(scanlineWidth * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * scanlineWidth;
    const pixelOffset = y * width * 4;
    raw[rawOffset] = 0;
    raw.set(
      rgbaPixels.subarray(pixelOffset, pixelOffset + width * 4),
      rawOffset + 1,
    );
  }
  return raw;
}

function ihdrBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  writeUint32(bytes, 0, width);
  writeUint32(bytes, 4, height);
  bytes[8] = 8;
  bytes[9] = 6;
  bytes[10] = 0;
  bytes[11] = 0;
  bytes[12] = 0;
  return bytes;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  writeUint32(chunk, 8 + data.length, crc32(crcInput));
  return chunk;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    table[index] = crc >>> 0;
  }
  return table;
}
