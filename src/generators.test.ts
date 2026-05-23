import { describe, expect, it } from "vitest";
import { effectDefinitions, sourceDefinitions, type ParameterSpec, type UnitDefinition } from "./generators";

const expectedRandomizationBounds: Record<string, Record<string, { min: number; max: number; integer?: boolean }>> = {
  "sinewave FM": {
    "modulator ratio": { min: 0.25, max: 32 },
    "modulator volume": { min: -36, max: 12 },
    "carrier ratio": { min: 1, max: 32 },
    "carrier volume": { min: -18, max: 0 },
  },
  "resonant sine": {
    "overtone ratio": { min: 1, max: 64 },
    "overtone shape": { min: 0, max: 100 },
    volume: { min: -24, max: 0 },
  },
  "merged sine": {
    "ratio A": { min: 1, max: 64 },
    "ratio B": { min: 1, max: 64 },
    volume: { min: -24, max: 0 },
  },
  noise: {
    seed: { min: 1, max: 9999, integer: true },
    rate: { min: 2, max: 128, integer: true },
    ramp: { min: 0, max: 100 },
    volume: { min: -36, max: -6 },
  },
  "hard clip": {
    gain: { min: -12, max: 36 },
    bias: { min: -100, max: 100 },
  },
  "soft clip": {
    gain: { min: -12, max: 36 },
    bias: { min: -100, max: 100 },
  },
  "bit crush": {
    bits: { min: 4, max: 16, integer: true },
  },
  downsample: {
    rate: { min: 2, max: 128, integer: true },
    ramp: { min: 0, max: 100 },
  },
  "ring mod": {
    ratio: { min: 1, max: 64 },
    "carrier gain": { min: 0, max: 32 },
  },
};

describe("generator randomization bounds", () => {
  it("declares intentional randomization bounds for every numeric generator parameter", () => {
    expect(parameterBounds()).toEqual(expectedRandomizationBounds);
  });

  it("keeps randomization bounds inside manual editing limits", () => {
    for (const definition of generatorDefinitions()) {
      for (const [parameterName, spec] of Object.entries(definition.parameters)) {
        if (typeof spec.default !== "number") {
          continue;
        }

        expect(spec.randomization, `${definition.name} ${parameterName}`).toBeDefined();
        const bounds = spec.randomization!;
        if (typeof spec.min === "number") {
          expect(bounds.min, `${definition.name} ${parameterName} min`).toBeGreaterThanOrEqual(spec.min);
        }
        if (typeof spec.max === "number") {
          expect(bounds.max, `${definition.name} ${parameterName} max`).toBeLessThanOrEqual(spec.max);
        }
        expect(bounds.max, `${definition.name} ${parameterName} span`).toBeGreaterThan(bounds.min);
      }
    }
  });

  it("marks inherently stepped randomization parameters as integer-valued", () => {
    const integerParameters = Object.entries(expectedRandomizationBounds).flatMap(([unitName, parameters]) =>
      Object.entries(parameters)
        .filter(([, bounds]) => bounds.integer)
        .map(([parameterName]) => `${unitName}::${parameterName}`),
    );

    expect(integerParameters).toEqual(["noise::seed", "noise::rate", "bit crush::bits", "downsample::rate"]);
  });
});

function generatorDefinitions(): UnitDefinition[] {
  return [...sourceDefinitions, ...effectDefinitions];
}

function parameterBounds(): Record<string, Record<string, { min: number; max: number; integer?: boolean }>> {
  return Object.fromEntries(
    generatorDefinitions().map((definition) => [
      definition.name,
      Object.fromEntries(
        Object.entries(definition.parameters)
          .filter(([, spec]) => typeof spec.default === "number")
          .map(([parameterName, spec]) => [parameterName, randomization(spec)]),
      ),
    ]),
  );
}

function randomization(spec: ParameterSpec): { min: number; max: number; integer?: boolean } {
  if (!spec.randomization) {
    throw new Error("Missing randomization bounds.");
  }
  return spec.randomization;
}
