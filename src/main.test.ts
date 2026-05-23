/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTables = [new Float32Array([0, 0.5, -0.5, 0])];
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
    resume = vi.fn(async () => undefined);
    suspend = vi.fn(async () => undefined);
    setTransportRunning = vi.fn();
    triggerFromPosition = vi.fn();
  },
}));

vi.mock("./plot", () => ({
  plotTable2D: vi.fn(),
  plotTable3D: vi.fn(),
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

  it("toggles generator, row, and field locks from the keyboard", async () => {
    await bootApp();
    pressKey("KeyJ", "j");
    pressKey("KeyN", "n");

    const selectedField = document.querySelector<HTMLInputElement>(".field-selected");
    const selectedRow = selectedField?.closest<HTMLTableRowElement>(".unit-parameter");
    const selectedUnit = selectedField?.closest<HTMLTableSectionElement>(".unit-body");

    pressKey("Digit3", "3");
    expect(selectedField?.closest("td")?.querySelector(".field-lock")?.getAttribute("aria-pressed")).toBe("true");

    pressKey("Digit2", "2");
    expect(selectedRow?.querySelector(".row-lock")?.getAttribute("aria-pressed")).toBe("true");

    pressKey("Digit1", "1");
    expect(selectedUnit?.querySelector(".unit-lock")?.getAttribute("aria-pressed")).toBe("true");
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

    document.getElementById("save-preset-button")?.click();
    const saveDialog = document.getElementById("save-preset-dialog") as HTMLDialogElement;
    expect(saveDialog.open).toBe(true);
    expect(saveDialog.textContent?.toLowerCase()).toContain("pull request");
    expect(saveDialog.textContent).toContain("public/presets");
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
