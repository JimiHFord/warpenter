import type { DesignerState, MorphedParameter } from "./synth";

export interface DesignerPatch {
  id: string;
  name: string;
  autoGenerate?: boolean;
  state: DesignerState;
}

function p(start: number, end = start, curve = 0, round = false): MorphedParameter {
  return { start, end, curve, round };
}

export const screenshotResonantClipRingPatch: DesignerPatch = {
  id: "screenshot-resonant-clip-ring",
  name: "Screenshot resonant clip ring",
  autoGenerate: true,
  state: {
    settings: {
      tableSizeBits: 11,
      tableSize: 2048,
      cycles: 128,
      fixNonZero: true,
      normalize: 2,
      removeDuplicates: true,
    },
    units: [
      {
        name: "sinewave FM",
        kind: "sources",
        enabled: false,
        parameters: {
          "modulator ratio": p(1),
          "modulator volume": p(-12),
          "carrier ratio": p(1),
          "carrier volume": p(0),
        },
      },
      {
        name: "resonant sine",
        kind: "sources",
        enabled: true,
        parameters: {
          "overtone ratio": p(1, 18, 12),
          "overtone shape": p(63, 0),
          volume: p(0),
        },
      },
      {
        name: "merged sine",
        kind: "sources",
        enabled: false,
        parameters: {
          "ratio A": p(1),
          "ratio B": p(1),
          volume: p(0),
        },
      },
      {
        name: "noise",
        kind: "sources",
        enabled: false,
        parameters: {
          seed: p(1),
          rate: p(32),
          ramp: p(100),
          volume: p(0),
        },
      },
      {
        name: "hard clip",
        kind: "effects",
        enabled: true,
        parameters: {
          gain: p(23, 0),
          bias: p(98, -49),
        },
      },
      {
        name: "soft clip",
        kind: "effects",
        enabled: false,
        parameters: {
          gain: p(0),
          bias: p(0),
        },
      },
      {
        name: "downsample",
        kind: "effects",
        enabled: false,
        parameters: {
          rate: p(32),
          ramp: p(0),
        },
      },
      {
        name: "ring mod",
        kind: "effects",
        enabled: true,
        parameters: {
          ratio: p(31, 17),
          "carrier gain": p(0),
        },
      },
    ],
  },
};

export const patches = {
  [screenshotResonantClipRingPatch.id]: screenshotResonantClipRingPatch,
} as const;

export type PatchId = keyof typeof patches;

const envDefaultPatchId = import.meta.env.VITE_DEFAULT_PATCH_ID?.trim() ?? "";
export const DEFAULT_PATCH_ID: PatchId | null =
  envDefaultPatchId && envDefaultPatchId in patches ? (envDefaultPatchId as PatchId) : null;

export function getConfiguredDefaultPatch(): DesignerPatch | null {
  return DEFAULT_PATCH_ID ? (patches[DEFAULT_PATCH_ID] ?? null) : null;
}
