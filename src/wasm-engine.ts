import type { DesignerState, RenderResult, UnitState } from "./synth";
import type { ExportEncoding, ExportFormat } from "./wav";

interface WasmGenerateResult {
  buffer: Float32Array;
  tableContainsOffset: boolean;
}

type WasmRenderResult = ArrayBuffer | Uint8Array | { buffer: ArrayBuffer | Uint8Array };

interface WasmModule {
  onRuntimeInitialized?: () => void;
  print?: (...args: unknown[]) => void;
  printErr?: (...args: unknown[]) => void;
  configDefaults: (format: number, encoding: number) => void;
  generate: (json: string) => WasmGenerateResult;
  render: (bytesPerSample: ExportEncoding, fileFormat: number, addClmChunk: number) => WasmRenderResult | undefined;
}

declare global {
  interface Window {
    Module?: Partial<WasmModule>;
    warpenterWasmEngine?: Promise<WasmModule>;
  }
}

function toWasmUnit(unit: UnitState): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    generator: unit.name,
  };

  for (const [name, parameter] of Object.entries(unit.parameters)) {
    serialized[name] = {
      start: parameter.start,
      end: parameter.end,
      curve: parameter.curve / 10,
      round: parameter.round,
    };
  }

  return serialized;
}

function toWasmJson(state: DesignerState): string {
  return JSON.stringify({
    settings: {
      tableSize: Math.max(1, Math.round(state.settings.tableSize)),
      numCycles: Math.max(1, Math.round(state.settings.cycles)),
      normalize: state.settings.normalize,
      fixNonZero: state.settings.fixNonZero,
      removeDuplicates: state.settings.removeDuplicates,
    },
    units: state.units.filter((unit) => unit.enabled).map(toWasmUnit),
  });
}

function cloneArrayBuffer(buffer: ArrayBufferLike, byteOffset = 0, byteLength = buffer.byteLength): ArrayBuffer {
  const out = new Uint8Array(byteLength);
  out.set(new Uint8Array(buffer, byteOffset, byteLength));
  return out.buffer;
}

function cloneRenderResult(rendered: WasmRenderResult): ArrayBuffer {
  if (rendered instanceof ArrayBuffer) {
    return cloneArrayBuffer(rendered);
  }

  if (ArrayBuffer.isView(rendered)) {
    return cloneArrayBuffer(rendered.buffer, rendered.byteOffset, rendered.byteLength);
  }

  const buffer = rendered.buffer;
  if (buffer instanceof ArrayBuffer) {
    return cloneArrayBuffer(buffer);
  }

  return cloneArrayBuffer(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function loadWasmEngine(): Promise<WasmModule> {
  if (window.warpenterWasmEngine) {
    return window.warpenterWasmEngine;
  }

  window.warpenterWasmEngine = new Promise<WasmModule>((resolve, reject) => {
    const existing = window.Module;
    if (existing && typeof existing.generate === "function" && typeof existing.render === "function") {
      resolve(existing as WasmModule);
      return;
    }

    const module: Partial<WasmModule> = {
      print: () => {},
      printErr: (...args: unknown[]) => console.error(...args),
      onRuntimeInitialized: () => resolve(module as WasmModule),
    };

    window.Module = module;

    const script = document.createElement("script");
    script.async = true;
    script.src = `${import.meta.env.BASE_URL}generator.js`;
    script.onerror = () => reject(new Error("Unable to load wavetable engine"));
    document.head.appendChild(script);
  });

  return window.warpenterWasmEngine;
}

export async function renderWasmWavetable(state: DesignerState): Promise<RenderResult> {
  const module = await loadWasmEngine();
  const tableSize = Math.max(1, Math.round(state.settings.tableSize));
  module.configDefaults(2, 1);
  const result = module.generate(toWasmJson(state));
  const tables: Float32Array[] = [];

  for (let offset = 0; offset < result.buffer.length; offset += tableSize) {
    tables.push(new Float32Array(result.buffer.slice(offset, offset + tableSize)));
  }

  return {
    tables,
    containsDcOffset: result.tableContainsOffset,
  };
}

export async function renderWasmExport(options: {
  encoding: ExportEncoding;
  format: ExportFormat;
  addClmChunk: boolean;
}): Promise<ArrayBuffer | null> {
  const module = await loadWasmEngine();
  const rendered = module.render(options.encoding, options.format === "wav" ? 0 : 1, options.addClmChunk ? 1 : 0);
  if (!rendered) {
    return null;
  }
  return cloneRenderResult(rendered);
}
