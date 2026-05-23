import type { ParameterValue, UnitKind } from "./generators";

export type NormalizeMode = 0 | 1 | 2 | 3;

export interface RenderSettings {
  tableSizeBits: number;
  tableSize: number;
  cycles: number;
  fixNonZero: boolean;
  normalize: NormalizeMode;
  removeDuplicates: boolean;
}

export interface MorphedParameter {
  start: ParameterValue;
  end: ParameterValue;
  curve: number;
  round: boolean;
}

export interface UnitState {
  name: string;
  kind: Exclude<UnitKind, "settings">;
  enabled: boolean;
  parameters: Record<string, MorphedParameter>;
}

export interface DesignerState {
  settings: RenderSettings;
  units: UnitState[];
}

export interface RenderResult {
  tables: Float32Array[];
  containsDcOffset: boolean;
}

const TAU = Math.PI * 2;

function clamp(input: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, input));
}

function lerp(pos: number, a: number, b: number): number {
  return a + pos * (b - a);
}

function dbToAmp(db: number): number {
  if (db <= -96) {
    return 0;
  }
  return Math.pow(10, db / 20);
}

function shapedPosition(position: number, curve: number): number {
  const amount = curve / 10;
  if (Math.abs(amount) < 0.000001) {
    return position;
  }

  return Math.pow(position, Math.pow(2, -amount));
}

function valueAt(parameter: MorphedParameter, cycle: number, cycles: number): ParameterValue {
  if (typeof parameter.start === "boolean") {
    return parameter.start;
  }

  const t = cycles <= 1 ? 0 : cycle / (cycles - 1);
  const value = lerp(shapedPosition(t, parameter.curve), Number(parameter.start), Number(parameter.end));
  return parameter.round ? Math.round(value) : value;
}

function numberParam(unit: UnitState, name: string, cycle: number, cycles: number): number {
  const parameter = unit.parameters[name];
  if (!parameter) {
    throw new Error(`${unit.name} is missing parameter ${name}`);
  }
  return Number(valueAt(parameter, cycle, cycles));
}

function nextNoiseState(state: bigint): { state: bigint; value: number } {
  const nextState = BigInt.asUintN(64, state * 196314165n + 907633515n);
  const value = Number(nextState >> 32n) * Math.pow(2, -31) - 1;
  return { state: nextState, value };
}

function sampleHoldNoise(tableSize: number, seed: number, rate: number, rampPercent: number): Float32Array {
  const roundedRate = Math.max(1, Math.round(rate));
  let state = BigInt.asIntN(64, BigInt(Math.round(seed) + 22222));
  return steppedRamp(tableSize, roundedRate, rampPercent, () => {
    const result = nextNoiseState(state);
    state = result.state;
    return result.value;
  });
}

function steppedRamp(
  tableSize: number,
  rate: number,
  rampPercent: number,
  nextValue: (sample: number, segmentLength: number) => number,
): Float32Array {
  const table = new Float32Array(tableSize);
  const roundedRate = Math.max(1, Math.round(rate));
  const segmentLength = tableSize / roundedRate;
  const ramp = Math.max(rampPercent / 100, 0.0001);
  const rampSamples = segmentLength * ramp;
  const inverseSegmentLength = 1 / segmentLength;
  const holdHalfLength = segmentLength * (1 - ramp) * 0.5;
  let current = 0;
  let previous = 0;
  let rampValue = 0;
  let slope = 0;
  let segmentPhase = 1;

  for (let sample = 0; sample < tableSize; sample += 1) {
    if (segmentPhase >= 1) {
      let next = 0;
      segmentPhase -= 1;

      if (inverseSegmentLength * (tableSize - sample) > 1) {
        next = nextValue(sample, segmentLength);
      }

      slope = (next - current) / rampSamples;
      rampValue = current - holdHalfLength * slope;
      previous = current;
      current = next;
    }

    const low = Math.min(current, previous);
    const high = Math.max(current, previous);
    table[sample] = clamp(rampValue, low, high);
    rampValue += slope;
    segmentPhase += inverseSegmentLength;
  }

  return table;
}

function addSinewaveFm(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const modRatio = numberParam(unit, "modulator ratio", cycle, cycles);
  const modVolume = dbToAmp(numberParam(unit, "modulator volume", cycle, cycles));
  const carrierRatio = numberParam(unit, "carrier ratio", cycle, cycles);
  const carrierVolume = dbToAmp(numberParam(unit, "carrier volume", cycle, cycles));

  for (let sample = 0; sample < target.length; sample += 1) {
    const phase = sample / target.length;
    const modulator = Math.sin(TAU * modRatio * phase) * modVolume;
    const carrierPhase = carrierRatio * phase + Math.sin(Math.PI * phase) * modulator;
    target[sample] = (target[sample] ?? 0) + Math.sin(TAU * carrierPhase) * carrierVolume;
  }
}

function addResonantSine(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const ratio = numberParam(unit, "overtone ratio", cycle, cycles);
  const shape = Math.pow(2, numberParam(unit, "overtone shape", cycle, cycles) / 25);
  const volume = dbToAmp(numberParam(unit, "volume", cycle, cycles));
  let previousPeak = 0;
  let divisor = 1;

  for (let sample = Math.ceil((0.25 / ratio) * target.length); sample >= 0; sample -= 1) {
    const phase = sample / target.length;
    const candidate = Math.sin(TAU * ratio * phase) * Math.pow(1 - phase, shape);
    divisor = candidate;
    if (candidate < previousPeak) {
      break;
    }
    previousPeak = candidate;
  }

  const gain = divisor === 0 ? 0 : volume / divisor;

  for (let sample = 0; sample < target.length; sample += 1) {
    const phase = sample / target.length;
    target[sample] = (target[sample] ?? 0) + Math.sin(TAU * ratio * phase) * Math.pow(1 - phase, shape) * gain;
  }
}

function addMergedSine(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const ratioA = numberParam(unit, "ratio A", cycle, cycles);
  const ratioB = numberParam(unit, "ratio B", cycle, cycles);
  const volume = dbToAmp(numberParam(unit, "volume", cycle, cycles));

  for (let sample = 0; sample < target.length; sample += 1) {
    const phase = sample / target.length;
    const a = Math.sin(TAU * ratioA * phase);
    const b = Math.sin(TAU * ratioB * phase);
    target[sample] = (target[sample] ?? 0) + Math.max(a, b) * volume;
  }
}

function addNoise(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const seed = numberParam(unit, "seed", cycle, cycles);
  const rate = numberParam(unit, "rate", cycle, cycles);
  const ramp = numberParam(unit, "ramp", cycle, cycles);
  const volume = dbToAmp(numberParam(unit, "volume", cycle, cycles));
  const noise = sampleHoldNoise(target.length, seed, rate, ramp);

  for (let sample = 0; sample < target.length; sample += 1) {
    target[sample] = (target[sample] ?? 0) + noise[sample]! * volume;
  }
}

function applyHardClip(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const gain = dbToAmp(numberParam(unit, "gain", cycle, cycles));
  const bias = clamp(numberParam(unit, "bias", cycle, cycles) / 100, -1, 1);

  for (let sample = 0; sample < target.length; sample += 1) {
    target[sample] = clamp((target[sample] ?? 0) * gain + bias, -1, 1) - bias;
  }
}

function applySoftClip(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const gain = dbToAmp(numberParam(unit, "gain", cycle, cycles));
  const bias = numberParam(unit, "bias", cycle, cycles) / 100;
  const gainScale = 1 / Math.tanh(gain);
  const biasOffset = -Math.tanh(bias);

  for (let sample = 0; sample < target.length; sample += 1) {
    target[sample] = Math.tanh((target[sample] ?? 0) * gain + bias) * gainScale + biasOffset;
  }
}

function applyBitCrush(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const bits = clamp(Math.round(numberParam(unit, "bits", cycle, cycles)), 1, 32);
  if (bits >= 32) {
    return;
  }

  const levels = Math.max(2, Math.pow(2, bits));
  for (let sample = 0; sample < target.length; sample += 1) {
    target[sample] = Math.round(clamp(target[sample]!, -1, 1) * levels) / levels;
  }
}

function applyDownsample(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const rate = Math.max(2, Math.round(numberParam(unit, "rate", cycle, cycles)));
  const ramp = clamp(numberParam(unit, "ramp", cycle, cycles) / 100, 0, 1);
  const copy = new Float32Array(target);
  const downsampled = steppedRamp(target.length, rate, ramp * 100, (sample, segmentLength) => {
    const nextIndex = Math.trunc(segmentLength + sample);
    return copy[nextIndex] ?? 0;
  });
  target.set(downsampled);
}

function applyRingMod(target: Float32Array, unit: UnitState, cycle: number, cycles: number): void {
  const ratio = numberParam(unit, "ratio", cycle, cycles);
  const carrierGain = dbToAmp(numberParam(unit, "carrier gain", cycle, cycles));
  const gainScale = 1 / Math.tanh(carrierGain);

  for (let sample = 0; sample < target.length; sample += 1) {
    const phase = sample / target.length;
    const carrier = Math.tanh(carrierGain * Math.sin(Math.PI * ratio * phase)) * gainScale;
    target[sample] = (target[sample] ?? 0) * carrier;
  }
}

function removeEndpoints(table: Float32Array): void {
  if (table.length < 2) {
    return;
  }

  const first = table[0] ?? 0;
  const final = table[table.length - 1] ?? 0;
  const start = Math.abs(first) < 0.01 ? 0 : first;
  const end = Math.abs(final) < 0.01 ? 0 : final;
  if (start === 0 && end === 0) {
    return;
  }
  const length = table.length;

  for (let sample = 0; sample < table.length; sample += 1) {
    const correction = lerp(sample / length, start, end);
    table[sample] = (table[sample] ?? 0) - correction;
  }
}

function normalizeTotal(tables: Float32Array[]): void {
  let max = 0;
  for (const table of tables) {
    for (const sample of table) {
      max = Math.max(max, Math.abs(sample));
    }
  }

  if (max <= 0) {
    return;
  }

  for (const table of tables) {
    for (let sample = 0; sample < table.length; sample += 1) {
      table[sample] = (table[sample] ?? 0) / max;
    }
  }
}

function normalizePerCycle(table: Float32Array, stretch: boolean): void {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let peak = 0;

  for (const sample of table) {
    min = Math.min(min, sample);
    max = Math.max(max, sample);
    peak = Math.max(peak, Math.abs(sample));
  }

  if (stretch) {
    const mid = (max + min) / 2;
    const halfRange = (max - min) / 2;
    if (halfRange > 0) {
      for (let sample = 0; sample < table.length; sample += 1) {
        table[sample] = (table[sample]! - mid) / halfRange;
      }
    }
    return;
  }

  if (peak > 0) {
    for (let sample = 0; sample < table.length; sample += 1) {
      table[sample] = (table[sample] ?? 0) / peak;
    }
  }
}

function tableMean(table: Float32Array): number {
  let sum = 0;
  for (const sample of table) {
    sum += sample;
  }
  return sum / table.length;
}

function dedupeTables(tables: Float32Array[]): Float32Array[] {
  const deduped: Float32Array[] = [];
  for (const table of tables) {
    const previous = deduped[deduped.length - 1];
    if (!previous || !sameTable(previous, table)) {
      deduped.push(table);
    }
  }
  return deduped.length > 0 ? deduped : tables.slice(0, 1);
}

function sameTable(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs((a[index] ?? 0) - (b[index] ?? 0)) > 0.000001) {
      return false;
    }
  }
  return true;
}

export function renderWavetable(state: DesignerState): RenderResult {
  const tableSize = Math.max(1, Math.round(state.settings.tableSize));
  const cycles = Math.max(1, Math.round(state.settings.cycles));
  const tables: Float32Array[] = [];

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const table = new Float32Array(tableSize);

    for (const unit of state.units) {
      if (!unit.enabled) {
        continue;
      }

      switch (unit.name) {
        case "sinewave FM":
          addSinewaveFm(table, unit, cycle, cycles);
          break;
        case "resonant sine":
          addResonantSine(table, unit, cycle, cycles);
          break;
        case "merged sine":
          addMergedSine(table, unit, cycle, cycles);
          break;
        case "noise":
          addNoise(table, unit, cycle, cycles);
          break;
        case "hard clip":
          applyHardClip(table, unit, cycle, cycles);
          break;
        case "soft clip":
          applySoftClip(table, unit, cycle, cycles);
          break;
        case "bit crush":
          applyBitCrush(table, unit, cycle, cycles);
          break;
        case "downsample":
          applyDownsample(table, unit, cycle, cycles);
          break;
        case "ring mod":
          applyRingMod(table, unit, cycle, cycles);
          break;
        default:
          throw new Error(`No renderer for unit ${unit.name}`);
      }
    }

    if (state.settings.fixNonZero) {
      removeEndpoints(table);
    }

    tables.push(table);
  }

  if (state.settings.normalize === 1) {
    normalizeTotal(tables);
  } else if (state.settings.normalize === 2) {
    for (const table of tables) {
      normalizePerCycle(table, false);
    }
  } else if (state.settings.normalize === 3) {
    for (const table of tables) {
      normalizePerCycle(table, true);
    }
  }

  for (const table of tables) {
    for (let sample = 0; sample < table.length; sample += 1) {
      table[sample] = clamp(table[sample] ?? 0, -1, 1);
    }
  }

  const containsDcOffset = tables.some((table) => Math.abs(tableMean(table)) > 0.02);
  const finalTables = state.settings.removeDuplicates ? dedupeTables(tables) : tables;
  return { tables: finalTables, containsDcOffset };
}
