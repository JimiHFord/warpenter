function clamp(input: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, input));
}

interface PlotTheme {
  background: string;
  grid: string;
  wave: string;
}

function readTheme(canvas: HTMLCanvasElement): PlotTheme {
  const rootStyle = getComputedStyle(document.documentElement);
  const canvasStyle = getComputedStyle(canvas);
  return {
    background: readCssColor(canvasStyle, "--canvas-bg", "#0d0f13"),
    grid: readCssColor(rootStyle, "--line", "#3b3e48"),
    wave: readCssColor(rootStyle, "--accent-strong", "rgb(255 155 0)"),
  };
}

function readCssColor(style: CSSStyleDeclaration, variableName: string, fallback: string): string {
  return style.getPropertyValue(variableName).trim() || fallback;
}

function colorWithAlpha(color: string, alpha: number): string {
  const hex = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu.exec(color);
  if (hex?.groups) {
    const red = Number.parseInt(hex.groups.red ?? "0", 16);
    const green = Number.parseInt(hex.groups.green ?? "0", 16);
    const blue = Number.parseInt(hex.groups.blue ?? "0", 16);
    return `rgb(${red} ${green} ${blue} / ${alpha})`;
  }

  const rgb = /^rgb(?:a)?\(\s*(?<red>[\d.]+)[,\s]+(?<green>[\d.]+)[,\s]+(?<blue>[\d.]+)/iu.exec(color);
  if (rgb?.groups) {
    return `rgb(${rgb.groups.red} ${rgb.groups.green} ${rgb.groups.blue} / ${alpha})`;
  }

  return color;
}

class IsometricContext {
  private readonly isoRotate: number;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly baseX: number,
    private readonly baseY: number,
    degrees: number,
  ) {
    this.isoRotate = (degrees * Math.PI) / 180;
  }

  maxIsoPlaneInWidth(width: number): [number, number] {
    const hypotenuse = width / Math.cos(this.isoRotate);
    const opposite = hypotenuse * Math.sin(this.isoRotate);
    return [hypotenuse, opposite];
  }

  beginPath(x: number, y: number, z: number): void {
    const coord = this.isoProject(x, y, z);
    this.ctx.beginPath();
    this.ctx.moveTo(this.baseX + coord.x, this.baseY + coord.y);
  }

  lineTo(x: number, y: number, z: number): void {
    const coord = this.isoProject(x, y, z);
    this.ctx.lineTo(this.baseX + coord.x, this.baseY + coord.y);
  }

  endPath(style?: string): void {
    if (style) {
      this.ctx.strokeStyle = style;
    }
    this.ctx.stroke();
  }

  private isoProject(x: number, y: number, z: number): { x: number; y: number } {
    return {
      x: (x - y) * Math.cos(this.isoRotate),
      y: (x + y) * Math.sin(this.isoRotate) - z,
    };
  }
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create 2D canvas context");
  }
  return context;
}

export function plotTable2D(canvas: HTMLCanvasElement, tables: Float32Array[], index: number): void {
  const table = tables[index];
  if (!table) {
    return;
  }

  const width = Math.max(320, Math.floor(canvas.getBoundingClientRect().width));
  canvas.width = width;
  canvas.height = Math.floor(width / 3);

  const ctx = getContext(canvas);
  const theme = readTheme(canvas);
  const halfHeight = canvas.height / 2;

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.grid;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

  ctx.beginPath();
  ctx.moveTo(0, Math.floor(halfHeight) + 0.5);
  ctx.lineTo(canvas.width - 1, Math.floor(halfHeight) + 0.5);
  ctx.stroke();

  ctx.beginPath();
  for (let px = 0; px < canvas.width; px += 1) {
    const sampleIndex = Math.floor((px / canvas.width) * table.length);
    const sample = table[sampleIndex] ?? 0;
    const y = halfHeight - sample * (halfHeight - 6);

    if (px === 0) {
      ctx.moveTo(px, y);
    } else {
      ctx.lineTo(px, y);
    }
  }

  ctx.strokeStyle = theme.wave;
  ctx.stroke();
}

export function plotTable3D(canvas: HTMLCanvasElement, tables: Float32Array[], selectedIndex: number): void {
  if (tables.length === 0) {
    return;
  }

  const width = Math.max(320, Math.floor(canvas.getBoundingClientRect().width));
  canvas.width = width;

  const ctx = getContext(canvas);
  const theme = readTheme(canvas);
  const waveGain = canvas.width / 15;
  const plotMargin = canvas.width / 25;
  const isoCtx = new IsometricContext(ctx, canvas.width / 2, waveGain + plotMargin, 20);
  const maxIsoSquare = isoCtx.maxIsoPlaneInWidth(canvas.width - 2 * plotMargin);
  canvas.height = Math.floor(maxIsoSquare[1] + 2 * (waveGain + plotMargin));

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.grid;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

  for (let z = -1; z <= 1; z += 1) {
    const isoDistance = maxIsoSquare[0] / 2;
    const zpos = z * waveGain;
    isoCtx.beginPath(0, 0, zpos);
    isoCtx.lineTo(0, isoDistance, zpos);
    isoCtx.lineTo(isoDistance, isoDistance, zpos);
    isoCtx.lineTo(isoDistance, 0, zpos);
    isoCtx.lineTo(0, 0, zpos);
    isoCtx.endPath(theme.grid);
  }

  for (let corner = 0; corner < 4; corner += 1) {
    const x = (corner % 2) * (maxIsoSquare[0] / 2);
    const y = Math.floor(corner / 2) * (maxIsoSquare[0] / 2);
    isoCtx.beginPath(x, y, -waveGain);
    isoCtx.lineTo(x, y, waveGain);
    isoCtx.endPath(theme.grid);
  }

  const alpha = clamp(33 / tables.length, 0.1, 0.5);
  const cycleYMult = (maxIsoSquare[0] / 2) / Math.max(1, tables.length - 1);
  ctx.lineWidth = 1;

  for (let cycle = 0; cycle < tables.length; cycle += 1) {
    const table = tables[cycle];
    if (!table) {
      continue;
    }

    const ypos = tables.length === 1 ? cycleYMult : (tables.length - 1 - cycle) * cycleYMult;
    isoCtx.beginPath(0, ypos, (table[0] ?? 0) * waveGain);

    const xMax = maxIsoSquare[0] / 2;
    for (let px = 0; px < xMax; px += 0.5) {
      const sampleIndex = Math.floor((px / xMax) * table.length);
      const sample = table[sampleIndex] ?? 0;
      isoCtx.lineTo(px, ypos, sample * waveGain);
    }

    isoCtx.endPath(cycle === selectedIndex ? theme.wave : colorWithAlpha(theme.wave, alpha));
  }
}
