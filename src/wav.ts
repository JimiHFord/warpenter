export type ExportFormat = "wav" | "wt";
export type ExportEncoding = 1 | 2 | 4;

export interface ExportOptions {
  tables: Float32Array[];
  encoding: ExportEncoding;
  format: ExportFormat;
  addClmChunk: boolean;
  sampleRate?: number;
}

const DEFAULT_SAMPLE_RATE = 44100;
const WAVETABLE_DESIGNER_STATE_CHUNK = "wtds";

function clampSample(sample: number): number {
  if (!Number.isFinite(sample)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, sample));
}

function flattenTables(tables: Float32Array[]): Float32Array {
  const totalLength = tables.reduce((sum, table) => sum + table.length, 0);
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const table of tables) {
    out.set(table, offset);
    offset += table.length;
  }
  return out;
}

function encodeSamples(samples: Float32Array, encoding: ExportEncoding): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * encoding);
  const view = new DataView(buffer);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampSample(samples[index] ?? 0);
    const offset = index * encoding;

    if (encoding === 1) {
      view.setUint8(offset, Math.round((sample + 1) * 127.5));
    } else if (encoding === 2) {
      view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
    } else {
      view.setFloat32(offset, sample, true);
    }
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function paddedSize(size: number): number {
  return size + (size % 2);
}

function createChunk(id: string, payload: ArrayBuffer): ArrayBuffer {
  const chunk = new ArrayBuffer(8 + paddedSize(payload.byteLength));
  const view = new DataView(chunk);
  writeAscii(view, 0, id);
  view.setUint32(4, payload.byteLength, true);
  new Uint8Array(chunk, 8).set(new Uint8Array(payload));
  return chunk;
}

function stringPayload(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  return payload;
}

function isRiffWave(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) {
    return false;
  }

  const view = new DataView(buffer);
  return readAscii(view, 0, 4) === "RIFF" && readAscii(view, 8, 4) === "WAVE";
}

function createFmtChunk(encoding: ExportEncoding, sampleRate: number): ArrayBuffer {
  const payload = new ArrayBuffer(16);
  const view = new DataView(payload);
  const isFloat = encoding === 4;
  const bitsPerSample = encoding * 8;
  const blockAlign = encoding;

  view.setUint16(0, isFloat ? 3 : 1, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * blockAlign, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);

  return createChunk("fmt ", payload);
}

function createClmChunk(cycleLength: number): ArrayBuffer {
  const text = `<!>${cycleLength}`;
  const payload = new ArrayBuffer(text.length + 1);
  const view = new DataView(payload);
  writeAscii(view, 0, text);
  view.setUint8(text.length, 0);
  return createChunk("clm ", payload);
}

function encodeWav(options: ExportOptions): ArrayBuffer {
  const samples = flattenTables(options.tables);
  const data = createChunk("data", encodeSamples(samples, options.encoding));
  const chunks = [
    createFmtChunk(options.encoding, options.sampleRate ?? DEFAULT_SAMPLE_RATE),
    ...(options.addClmChunk && options.tables[0] ? [createClmChunk(options.tables[0].length)] : []),
    data,
  ];
  const riffSize = 4 + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const wav = new ArrayBuffer(8 + riffSize);
  const view = new DataView(wav);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, riffSize, true);
  writeAscii(view, 8, "WAVE");

  let offset = 12;
  for (const chunk of chunks) {
    new Uint8Array(wav, offset).set(new Uint8Array(chunk));
    offset += chunk.byteLength;
  }

  return wav;
}

export function encodeWavetable(options: ExportOptions): ArrayBuffer {
  if (options.format === "wav") {
    return encodeWav(options);
  }

  return encodeSamples(flattenTables(options.tables), options.encoding);
}

export function attachWavetableStateMetadata(buffer: ArrayBuffer, encodedState: string): ArrayBuffer {
  if (!isRiffWave(buffer)) {
    throw new Error("Wavetable state metadata can only be attached to a RIFF/WAVE file.");
  }

  const metadata = createChunk(WAVETABLE_DESIGNER_STATE_CHUNK, stringPayload(encodedState));
  const output = new ArrayBuffer(buffer.byteLength + metadata.byteLength);
  const bytes = new Uint8Array(output);
  bytes.set(new Uint8Array(buffer), 0);
  bytes.set(new Uint8Array(metadata), buffer.byteLength);

  new DataView(output).setUint32(4, output.byteLength - 8, true);
  return output;
}

export function extractWavetableStateMetadata(buffer: ArrayBuffer): string | null {
  if (!isRiffWave(buffer)) {
    return null;
  }

  const view = new DataView(buffer);
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const nextOffset = payloadOffset + paddedSize(chunkSize);

    if (payloadOffset + chunkSize > buffer.byteLength) {
      return null;
    }

    if (chunkId === WAVETABLE_DESIGNER_STATE_CHUNK) {
      return new TextDecoder().decode(new Uint8Array(buffer, payloadOffset, chunkSize));
    }

    offset = nextOffset;
  }

  return null;
}

export function formatReadableBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;

  while (value > 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit]}`;
}
