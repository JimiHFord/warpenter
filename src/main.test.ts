/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTables = [new Float32Array([0, 0.5, -0.5, 0])];
const audioInstances = vi.hoisted(() => [] as Array<{
  onCycle: ((cycle: number) => void) | null;
  updateParameter: ReturnType<typeof vi.fn>;
  setPositionHold: ReturnType<typeof vi.fn>;
}>);
const plotCalls = vi.hoisted(() => [] as Array<{ kind: "2d" | "3d"; selected: number }>);
let rafQueue: FrameRequestCallback[] = [];
let documentListeners: Array<{
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}> = [];

vi.mock("./audio", () => ({
  WavetableAudio: class {
    onCycle: ((cycle: number) => void) | null = null;

    updateTables = vi.fn();
    updateParameter = vi.fn();
    updateLfoMode = vi.fn();
    setPositionHold = vi.fn();
    resume = vi.fn(async () => undefined);
    suspend = vi.fn(async () => undefined);
    setTransportRunning = vi.fn();
    triggerFromPosition = vi.fn();

    constructor() {
      audioInstances.push(this);
    }
  },
}));

vi.mock("./plot", () => ({
  plotTable2D: vi.fn((_canvas: HTMLCanvasElement, _tables: Float32Array[], selected: number) => {
    plotCalls.push({ kind: "2d", selected });
  }),
  plotTable3D: vi.fn((_canvas: HTMLCanvasElement, _tables: Float32Array[], selected: number) => {
    plotCalls.push({ kind: "3d", selected });
  }),
}));

vi.mock("./wasm-engine", () => ({
  renderWasmWavetable: vi.fn(async () => ({ tables: mockTables, containsDcOffset: false })),
  renderWasmExport: vi.fn(async () => null),
}));

vi.mock("./wav", () => ({
  attachWavetableStateMetadata: vi.fn((buffer: ArrayBuffer) => buffer),
  encodeWavetable: vi.fn(() => new ArrayBuffer(44)),
  extractWavetableStateMetadata: vi.fn(() => null),
  formatReadableBytes: vi.fn((bytes: number) => `${bytes} B`),
}));

describe("Warpenter app", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    audioInstances.length = 0;
    plotCalls.length = 0;
    HTMLElement.prototype.setPointerCapture ??= vi.fn();
    HTMLElement.prototype.releasePointerCapture ??= vi.fn();
    HTMLElement.prototype.hasPointerCapture ??= vi.fn(() => true);
    const css = (window.CSS ?? {}) as { escape?: (value: string) => string };
    css.escape ??= (value: string) => value.replace(/"/g, '\\"');
    window.CSS = css as typeof window.CSS;
    HTMLDialogElement.prototype.showModal ??= function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close ??= function close() {
      this.removeAttribute("open");
    };
    rafQueue = [];
    documentListeners = [];
    vi.spyOn(document, "addEventListener").mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        documentListeners.push({ type, listener, options });
        EventTarget.prototype.addEventListener.call(document, type, listener, options);
      },
    );
    window.requestAnimationFrame ??= (() => 0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
  });

  afterEach(() => {
    documentListeners.forEach(({ type, listener, options }) => {
      document.removeEventListener(type, listener, options);
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders icon modal controls, a repository link, and nearest note names for frequency", async () => {
    await bootApp();

    const title = document.querySelector("h1");
    expect(title?.childNodes[0]?.textContent?.trim()).toBe("Warpenter");
    expect(title?.lastElementChild?.classList.contains("logo")).toBe(true);

    const infoButton = document.getElementById("open-info");
    expect(infoButton?.classList.contains("icon-button")).toBe(true);
    expect(infoButton?.getAttribute("title")).toBe("About Warpenter");
    expect(document.getElementById("open-help")?.classList.contains("help-icon")).toBe(true);

    infoButton?.click();
    const infoDialog = document.getElementById("info-dialog") as HTMLDialogElement;
    expect(infoDialog.open).toBe(true);
    const repoLink = infoDialog.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/JimiHFord/warpenter"]',
    );
    expect(repoLink?.querySelector(".github-icon")).not.toBeNull();

    const frequencyOutput = document.getElementById("audio-frequency-output") as HTMLOutputElement;
    expect(frequencyOutput.value).toMatch(/Hz \(C\)$/);
  });

  it("uses compact per-generator parameter editors instead of the stale global column labels", async () => {
    await bootApp();

    expect(document.querySelector("#unit-list thead")).toBeNull();
    const unit = generatorBodies()[0];
    expect(unit?.querySelector(".unit-name-row .unit-lock")).not.toBeNull();
    expect(unit?.querySelector(".unit-actions .unit-lock")).toBeNull();

    const row = unit?.querySelector<HTMLTableRowElement>(".unit-parameter");
    expect(row?.querySelector(".parameter-editor-row")).not.toBeNull();
    expect(row?.querySelector(".field-editor .field-lock")).not.toBeNull();
    expect(unit?.querySelectorAll(".unit-field-label-row").length).toBe(1);
    expect(row?.querySelector(".field-label")).toBeNull();
    const fieldLabels = Array.from(unit?.querySelectorAll(".unit-field-label-row .field-column-label") ?? []).map(
      (label) => label.textContent,
    );
    expect(fieldLabels).toEqual(["Start", "End", "Curve", "Round"]);
  });

  it("supports single-key generator navigation without putting selection into undo history", async () => {
    await bootApp();

    const undoButton = document.getElementById("undo-button") as HTMLButtonElement;
    pressKey("KeyJ", "j");
    const selectedUnit = document.querySelector<HTMLTableSectionElement>(".unit-body.unit-selected");
    expect(selectedUnit?.dataset.unitName).toBe("resonant sine");
    expect(undoButton.disabled).toBe(true);

    pressKey("KeyN", "n");
    expect(selectedUnit?.querySelector(".field-selected")).not.toBeNull();
    expect(undoButton.disabled).toBe(true);

    pressKey("KeyD", "d");
    const reorderedUnits = generatorBodies();
    expect(reorderedUnits[2]).toBe(selectedUnit);
    expect(undoButton.disabled).toBe(false);

    const enabled = selectedUnit?.querySelector<HTMLInputElement>(".unit-enabled");
    const wasEnabled = enabled?.checked;
    pressKey("KeyM", "m");
    expect(enabled?.checked).toBe(!wasEnabled);
  });

  it("randomizes selected scopes while lock buttons exclude generators, rows, and fields", async () => {
    await bootApp();
    vi.spyOn(Math, "random").mockReturnValue(0.75);

    pressKey("KeyJ", "j");
    pressKey("KeyN", "n");
    const selectedField = document.querySelector<HTMLInputElement>(".field-selected");
    expect(selectedField).not.toBeNull();

    const originalValue = selectedField?.value;
    pressKey("KeyV", "v");
    expect(selectedField?.value).not.toBe(originalValue);

    const fieldLockedValue = selectedField?.value;
    const fieldLock = selectedField?.closest("td")?.querySelector<HTMLButtonElement>(".field-lock");
    fieldLock?.click();
    expect(fieldLock?.getAttribute("aria-pressed")).toBe("true");
    pressKey("KeyV", "v");
    expect(selectedField?.value).toBe(fieldLockedValue);

    const selectedRow = selectedField?.closest<HTMLTableRowElement>(".unit-parameter");
    const rowPeer = selectedRow?.querySelector<HTMLInputElement>(".linear-end");
    const rowPeerValue = rowPeer?.value;
    const rowLock = selectedRow?.querySelector<HTMLButtonElement>(".row-lock");
    rowLock?.click();
    expect(rowLock?.getAttribute("aria-pressed")).toBe("true");
    pressKey("KeyR", "r");
    expect(rowPeer?.value).toBe(rowPeerValue);

    const selectedUnit = selectedField?.closest<HTMLTableSectionElement>(".unit-body");
    const unitPeer = selectedUnit?.querySelector<HTMLInputElement>('tr[data-parameter-name="overtone shape"] .linear-start');
    const unitPeerValue = unitPeer?.value;
    const unitLock = selectedUnit?.querySelector<HTMLButtonElement>(".unit-lock");
    unitLock?.click();
    expect(unitLock?.getAttribute("aria-pressed")).toBe("true");
    pressKey("KeyG", "g");
    expect(unitPeer?.value).toBe(unitPeerValue);
  });

  it("keeps selection synced while tabbing to lock controls without digit lock shortcuts", async () => {
    await bootApp();
    pressKey("KeyJ", "j");
    pressKey("KeyN", "n");

    const selectedField = document.querySelector<HTMLInputElement>(".field-selected");
    const selectedRow = selectedField?.closest<HTMLTableRowElement>(".unit-parameter");
    const selectedUnit = selectedField?.closest<HTMLTableSectionElement>(".unit-body");
    const fieldLock = selectedField?.closest("td")?.querySelector<HTMLButtonElement>(".field-lock");

    fieldLock?.focus();
    expect(document.querySelector<HTMLInputElement>(".field-selected")).toBe(selectedField);

    pressKey("Digit3", "3");
    expect(fieldLock?.getAttribute("aria-pressed")).toBe("false");

    selectedRow?.querySelector<HTMLButtonElement>(".row-lock")?.focus();
    expect(document.querySelector<HTMLTableRowElement>(".row-selected")).toBe(selectedRow);

    selectedUnit?.querySelector<HTMLButtonElement>(".unit-lock")?.focus();
    expect(document.querySelector<HTMLTableSectionElement>(".unit-selected")).toBe(selectedUnit);
  });

  it("keeps workflow shortcuts active in generator fields but inactive in the export name field", async () => {
    await bootApp();
    pressKey("KeyJ", "j");
    pressKey("KeyN", "n");

    const firstField = document.querySelector<HTMLInputElement>(".field-selected");
    firstField?.focus();
    pressKey("KeyN", "n");
    expect(document.querySelector<HTMLInputElement>(".field-selected")).not.toBe(firstField);

    const selectedBeforeFileName = document.querySelector<HTMLTableSectionElement>(".unit-selected");
    const fileName = document.getElementById("file-name") as HTMLInputElement;
    fileName.focus();
    pressKey("KeyJ", "j");
    expect(document.querySelector<HTMLTableSectionElement>(".unit-selected")).toBe(selectedBeforeFileName);
  });

  it("starts first-load exports with a timestamped Warpenter filename", async () => {
    await bootApp();
    expect((document.getElementById("file-name") as HTMLInputElement).value).toMatch(
      /^warpenter-wt-\d{8}-\d{4}$/,
    );
  });

  it("defaults the position LFO to 32% only when no persisted state exists", async () => {
    await bootApp();

    expect((document.getElementById("audio-lfo") as HTMLInputElement).value).toBe("32");
    expect((document.getElementById("audio-lfo-output") as HTMLOutputElement).value).toBe("32%");
  });

  it("keeps a persisted position LFO instead of applying the first-load default", async () => {
    window.localStorage.setItem(
      "warpenter-state-v1",
      JSON.stringify({
        version: 1,
        designer: {
          settings: {
            tableSizeBits: 11,
            tableSize: 2048,
            cycles: 128,
            fixNonZero: true,
            normalize: 2,
            removeDuplicates: true,
          },
          units: [],
        },
        audio: {
          volume: -36,
          frequency: 6.0313,
          lfo: 0,
          lfoMode: "wrap",
          position: 0,
          midiEnabled: false,
          midiInputId: "",
        },
        ui: {
          theme: "neon-purple",
          autoGenerate: true,
          fileName: "saved-wavetable",
          fileBits: 4,
          fileFormat: "wav",
          addClmChunk: false,
          addCycleLength: true,
          collapsedUnits: [],
          randomizationLocks: { units: [], rows: [], fields: [] },
        },
      }),
    );

    await bootApp();

    expect((document.getElementById("audio-lfo") as HTMLInputElement).value).toBe("0");
    expect((document.getElementById("audio-lfo-output") as HTMLOutputElement).value).toBe("0%");
  });

  it("lazy-loads presets, makes preset loading undoable, and opens save instructions", async () => {
    const presetState = {
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
          enabled: true,
          parameters: {
            "modulator ratio": { start: 7, end: 7, curve: 0, round: false },
            "modulator volume": { start: -12, end: -12, curve: 0, round: false },
            "carrier ratio": { start: 1, end: 1, curve: 0, round: false },
            "carrier volume": { start: 0, end: 0, curve: 0, round: false },
          },
        },
      ],
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.includes("presets/index.json")) {
        return new Response(
          JSON.stringify({
            presets: [{ id: "test-preset", name: "Test preset", path: "test-preset.json", description: "TDD preset" }],
          }),
        );
      }
      if (requestUrl.includes("presets/test-preset.json")) {
        return new Response(JSON.stringify({ id: "test-preset", name: "Test preset", state: presetState }));
      }
      throw new Error(`Unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await bootApp();
    expect(fetchMock).not.toHaveBeenCalled();
    const originalValue = parameterStartValue("modulator ratio");

    document.getElementById("presets-tab")?.click();
    await waitFor(() => document.querySelector<HTMLButtonElement>(".preset-load"));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("presets/index.json"));

    document.querySelector<HTMLButtonElement>(".preset-load")?.click();
    await waitFor(() => parameterStartValue("modulator ratio") === "7");
    expect((document.getElementById("undo-button") as HTMLButtonElement).disabled).toBe(false);

    document.getElementById("undo-button")?.click();
    await waitFor(() => parameterStartValue("modulator ratio") === originalValue);

    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    const topSaveButton = document.getElementById("header-save-preset-button");
    expect(topSaveButton?.getAttribute("title")).toBe("Save preset");
    topSaveButton?.click();
    const saveDialog = document.getElementById("save-preset-dialog") as HTMLDialogElement;
    expect(saveDialog.open).toBe(true);
    expect(saveDialog.textContent?.toLowerCase()).toContain("pull request");
    expect(saveDialog.textContent).toContain("public/presets");
    expect(saveDialog.textContent).not.toContain("index.json");
    expect(saveDialog.querySelector<HTMLAnchorElement>('a[href="https://github.com/JimiHFord/warpenter"]')).not.toBeNull();
    expect(saveDialog.querySelector<HTMLDetailsElement>("#preset-json-details")?.open).toBe(false);
    await waitFor(() => document.getElementById("save-preset-status")?.textContent?.includes("Copied"));

    const presetJson = (document.getElementById("save-preset-json") as HTMLTextAreaElement).value;
    expect(clipboardWrite).toHaveBeenCalledWith(presetJson);
    const parsedPreset = JSON.parse(presetJson) as { id: string; name: string; description?: string };
    expect(saveDialog.textContent).toContain(`${parsedPreset.id}.json`);
    expect(parsedPreset.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parsedPreset.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(parsedPreset.description).toBe("");

    vi.useFakeTimers();
    const copyButton = document.getElementById("copy-preset-json-button");
    expect(copyButton?.classList.contains("copy-icon")).toBe(true);
    expect(copyButton?.textContent?.trim()).toBe("");
    copyButton?.click();
    await Promise.resolve();
    expect(clipboardWrite).toHaveBeenCalledTimes(2);
    expect(document.getElementById("save-preset-status")?.textContent).toContain("Copied");

    vi.advanceTimersByTime(1800);
    expect(document.getElementById("save-preset-status")?.textContent).toBe("");
  });

  it("keeps the selected position stable while showing LFO playback as a ghost indicator", async () => {
    await bootApp();
    const audio = audioInstances.at(-1);
    const position = document.getElementById("audio-position") as HTMLInputElement;
    const positionField = position.closest<HTMLElement>(".knob-field");
    position.max = "127";
    position.value = "12";

    audio?.onCycle?.(47);

    expect(position.value).toBe("12");
    expect(positionField?.classList.contains("knob-ghost-active")).toBe(true);
    expect(positionField?.style.getPropertyValue("--knob-ghost-angle")).not.toBe("");
  });

  it("sends literal zero to audio when the LFO UI rounds to zero", async () => {
    await bootApp();
    const audio = audioInstances.at(-1);
    const lfo = document.getElementById("audio-lfo") as HTMLInputElement;
    lfo.value = "0.3";
    lfo.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(lfo.value).toBe("0");
    expect((document.getElementById("audio-lfo-output") as HTMLOutputElement).value).toBe("0%");
    expect(audio?.updateParameter).toHaveBeenCalledWith("lfo", 0);
  });

  it("uses the current playing cycle for visualizers and position ghost while audio is running", async () => {
    await bootApp();
    plotCalls.length = 0;
    const audio = audioInstances.at(-1);
    const position = document.getElementById("audio-position") as HTMLInputElement;
    position.max = "127";
    position.value = "12";

    document.getElementById("audio-preview-toggle")?.click();
    await Promise.resolve();
    audio?.onCycle?.(47);
    flushAnimationFrames(2);

    expect(position.value).toBe("12");
    expect(plotCalls.some((call) => call.selected === 47)).toBe(true);
  });

  it("holds position LFO while dragging the playing position and releases it on pointer up", async () => {
    await bootApp();
    const audio = audioInstances.at(-1);
    document.getElementById("audio-preview-toggle")?.click();
    await Promise.resolve();

    const shell = document.querySelector<HTMLElement>('[data-knob-for="audio-position"] .knob-shell');
    shell?.dispatchEvent(pointerEvent("pointerdown", { pointerId: 7, clientY: 100 }));
    expect(audio?.setPositionHold).toHaveBeenCalledWith(true);

    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 7, clientY: 100 }));
    expect(audio?.setPositionHold).toHaveBeenCalledWith(false);
  });
});

async function bootApp(): Promise<void> {
  await import("./main");
  await Promise.resolve();
  flushAnimationFrames(4);
  await Promise.resolve();
}

function flushAnimationFrames(limit: number): void {
  for (let index = 0; index < limit; index += 1) {
    const pending = rafQueue.splice(0);
    if (pending.length === 0) {
      return;
    }
    pending.forEach((callback) => callback(performance.now()));
  }
}

function pressKey(code: string, key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code, key }));
}

function pointerEvent(type: string, values: { pointerId: number; clientY: number }): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientY: { value: values.clientY },
    preventDefault: { value: vi.fn() },
  });
  return event;
}

function generatorBodies(): HTMLTableSectionElement[] {
  return Array.from(document.querySelectorAll<HTMLTableSectionElement>(".unit-body")).filter(
    (body) => !body.classList.contains("unit-settings"),
  );
}

function parameterStartValue(parameterName: string): string {
  return (
    document.querySelector<HTMLInputElement>(
      `tr[data-parameter-name="${window.CSS.escape(parameterName)}"] .linear-start`,
    )?.value ?? ""
  );
}

async function waitFor(assertion: () => unknown): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (assertion()) {
      return;
    }
    await Promise.resolve();
  }
  expect(assertion()).toBeTruthy();
}
