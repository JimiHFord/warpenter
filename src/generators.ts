export type UnitKind = "settings" | "sources" | "effects";

export type ParameterValue = number | boolean;

export interface ParameterSpec {
  default: ParameterValue;
  min?: number;
  max?: number;
  type?: string;
  options?: readonly string[];
}

export interface UnitDefinition {
  name: string;
  kind: UnitKind;
  functionName?: string;
  enabled?: boolean;
  parameters: Record<string, ParameterSpec>;
}

export const settingsDefinition: UnitDefinition = {
  name: "settings",
  kind: "settings",
  parameters: {
    "table size": {
      type: "bits",
      default: 11,
      min: 8,
      max: 13,
    },
    cycles: {
      min: 1,
      default: 128,
    },
    "fix non-zero start/end": {
      default: false,
    },
    normalize: {
      default: 0,
      options: ["-", "in total", "per cycle", "stretch cycle"],
    },
    "remove duplicates": {
      default: false,
    },
  },
};

export const sourceDefinitions: UnitDefinition[] = [
  {
    name: "sinewave FM",
    kind: "sources",
    functionName: "sinewaveFM",
    enabled: true,
    parameters: {
      "modulator ratio": { default: 1, min: 0, max: 256 },
      "modulator volume": { type: "dB", default: -12, min: -96, max: 24 },
      "carrier ratio": { default: 1, min: 1, max: 256 },
      "carrier volume": { type: "dB", default: 0, min: -96, max: 0 },
    },
  },
  {
    name: "resonant sine",
    kind: "sources",
    functionName: "resonantSine",
    parameters: {
      "overtone ratio": { default: 1, min: 1, max: 256 },
      "overtone shape": { default: 0, min: 0, max: 100 },
      volume: { type: "dB", default: 0, min: -96, max: 0 },
    },
  },
  {
    name: "merged sine",
    kind: "sources",
    functionName: "peakSine",
    parameters: {
      "ratio A": { default: 1, min: 1, max: 256 },
      "ratio B": { default: 1, min: 1, max: 256 },
      volume: { type: "dB", default: 0, min: -96, max: 0 },
    },
  },
  {
    name: "noise",
    kind: "sources",
    functionName: "noise",
    parameters: {
      seed: { default: 1, min: 1 },
      rate: { default: 32, min: 2 },
      ramp: { type: "%", default: 100, min: 0, max: 100 },
      volume: { type: "dB", default: 0, min: -96, max: 0 },
    },
  },
];

export const effectDefinitions: UnitDefinition[] = [
  {
    name: "hard clip",
    kind: "effects",
    functionName: "clip",
    parameters: {
      gain: { type: "dB", default: 0, min: -64, max: 64 },
      bias: { type: "%", default: 0, min: -200, max: 200 },
    },
  },
  {
    name: "soft clip",
    kind: "effects",
    functionName: "tanh",
    parameters: {
      gain: { type: "dB", default: 0, min: -64, max: 64 },
      bias: { type: "%", default: 0, min: -200, max: 200 },
    },
  },
  {
    name: "bit crush",
    kind: "effects",
    functionName: "bitCrush",
    parameters: {
      bits: { default: 32, min: 1, max: 32 },
    },
  },
  {
    name: "downsample",
    kind: "effects",
    functionName: "downsample",
    parameters: {
      rate: { default: 32, min: 2 },
      ramp: { type: "%", default: 0, min: 0, max: 100 },
    },
  },
  {
    name: "ring mod",
    kind: "effects",
    functionName: "ringmod",
    parameters: {
      ratio: { default: 1, min: 1, max: 256 },
      "carrier gain": { default: 0, min: 0, max: 64 },
    },
  },
];

export const unitDefinitions = [...sourceDefinitions, ...effectDefinitions];

export function findDefinition(name: string): UnitDefinition {
  const definition = unitDefinitions.find((unit) => unit.name === name);
  if (!definition) {
    throw new Error(`Unknown generator unit: ${name}`);
  }
  return definition;
}
