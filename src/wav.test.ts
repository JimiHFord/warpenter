import { describe, expect, it } from "vitest";
import { attachWavetableStateMetadata, encodeWavetable, extractWavetableStateMetadata } from "./wav";

function ascii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function paddedSize(size: number): number {
  return size + (size % 2);
}

function findInfoSubchunk(buffer: ArrayBuffer, subchunkId: string): string | null {
  const view = new DataView(buffer);
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = ascii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;

    if (chunkId === "LIST" && ascii(view, payloadOffset, 4) === "INFO") {
      let infoOffset = payloadOffset + 4;
      const infoEnd = payloadOffset + chunkSize;
      while (infoOffset + 8 <= infoEnd) {
        const id = ascii(view, infoOffset, 4);
        const size = view.getUint32(infoOffset + 4, true);
        const valueOffset = infoOffset + 8;
        if (id === subchunkId) {
          const bytes = new Uint8Array(buffer, valueOffset, size);
          return new TextDecoder().decode(bytes).replace(/\0+$/u, "");
        }
        infoOffset = valueOffset + paddedSize(size);
      }
    }

    offset = payloadOffset + paddedSize(chunkSize);
  }

  return null;
}

describe("WAV metadata", () => {
  it("adds restorable patch state and Warpenter creator metadata", () => {
    const wav = encodeWavetable({
      tables: [new Float32Array([0, 0.5, -0.5, 0])],
      encoding: 4,
      format: "wav",
      addClmChunk: false,
    });

    const output = attachWavetableStateMetadata(wav, "encoded-state");

    expect(extractWavetableStateMetadata(output)).toBe("encoded-state");
    expect(findInfoSubchunk(output, "ISFT")).toBe(
      "Created with Warpenter - https://github.com/JimiHFord/warpenter",
    );
    expect(new DataView(output).getUint32(4, true)).toBe(output.byteLength - 8);
  });
});
