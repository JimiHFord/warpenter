import "./styles.css";
import logoMarkup from "./assets/warpenter-logo-top.svg?raw";
import { WavetableAudio, type LfoMode } from "./audio";
import {
  effectDefinitions,
  findDefinition,
  settingsDefinition,
  sourceDefinitions,
  type ParameterSpec,
  type ParameterValue,
  type UnitDefinition,
} from "./generators";
import { getConfiguredDefaultPatch, patches, type DesignerPatch } from "./patches";
import { plotTable2D, plotTable3D } from "./plot";
import type { DesignerState, MorphedParameter, NormalizeMode, UnitState } from "./synth";
import {
  attachWavetableStateMetadata,
  encodeWavetable,
  extractWavetableStateMetadata,
  formatReadableBytes,
  type ExportEncoding,
  type ExportFormat,
} from "./wav";
import { renderWasmExport, renderWasmWavetable } from "./wasm-engine";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) {
  throw new Error("Missing app root");
}
const appElement: HTMLDivElement = appRoot;

const THEME_OPTIONS = [
  { id: "neon-purple", label: "Neon purple" },
  { id: "classic-orange", label: "Classic orange" },
  { id: "acid-lime", label: "Acid lime" },
  { id: "cyan-circuit", label: "Cyan circuit" },
  { id: "hot-coral", label: "Hot coral" },
  { id: "emerald-gold", label: "Emerald gold" },
  { id: "ruby-ice", label: "Ruby ice" },
  { id: "vapor-sunset", label: "Vapor sunset" },
  { id: "graphite-mono", label: "Graphite mono" },
  { id: "ultraviolet-mint", label: "Ultraviolet mint" },
  { id: "ocean-amber", label: "Ocean amber" },
  { id: "slate-rose", label: "Slate rose" },
  { id: "virtual-riot", label: "Virtual Riot" },
] as const;

type ThemeId = (typeof THEME_OPTIONS)[number]["id"];

interface AudioUiState {
  volume: number;
  frequency: number;
  lfo: number;
  lfoMode: LfoMode;
  position: number;
  midiEnabled: boolean;
  midiInputId: string;
}

interface UiState {
  theme: ThemeId;
  autoGenerate: boolean;
  fileName: string;
  fileBits: ExportEncoding;
  fileFormat: ExportFormat;
  addClmChunk: boolean;
  addCycleLength: boolean;
  collapsedUnits: string[];
  randomizationLocks: RandomizationLocks;
}

interface AppState {
  version: 1;
  designer: DesignerState;
  audio: AudioUiState;
  ui: UiState;
}

interface RandomizationLocks {
  units: string[];
  rows: string[];
  fields: string[];
}

interface PresetIndexEntry {
  id: string;
  name: string;
  path: string;
  description?: string;
  modified?: string;
  author?: string;
  authorUrl?: string;
}

interface PresetDocument {
  id: string;
  name: string;
  state: DesignerState;
}

const configuredDefaultTheme = import.meta.env.VITE_DEFAULT_THEME?.trim();
const DEFAULT_THEME_ID: ThemeId = isThemeId(configuredDefaultTheme) ? configuredDefaultTheme : "neon-purple";
const DEFAULT_EXPORT_FILE_NAME = createDefaultFileName();
const STORAGE_KEY = "warpenter-state-v1";
const STORAGE_WRITE_DELAY_MS = 350;
const MAX_HISTORY_STATES = 100;
const FIELD_SELECTOR = ".linear-start, .linear-end, .linear-curve, .linear-round";
const EMPTY_RANDOMIZATION_LOCKS: RandomizationLocks = { units: [], rows: [], fields: [] };
const PRESET_PAGE_SIZE = 8;
const PRESET_ADJECTIVES = [
  "Aerial",
  "Bright",
  "Cosmic",
  "Electric",
  "Glowing",
  "Liquid",
  "Neon",
  "Prismatic",
  "Velvet",
  "Warped",
] as const;
const PRESET_NOUNS = [
  "Anvil",
  "Beacon",
  "Chisel",
  "Circuit",
  "Frame",
  "Lathe",
  "Plank",
  "Pulse",
  "Spline",
  "Vertex",
] as const;

const DEFAULT_AUDIO_STATE: AudioUiState = {
  volume: -36,
  frequency: 6.0313,
  lfo: 32,
  lfoMode: "wrap",
  position: 0,
  midiEnabled: false,
  midiInputId: "",
};

let draggingBody: HTMLTableSectionElement | null = null;
let waveTables: Float32Array[] = [];
let plotUpdateRequested = true;
let generateTimer: number | null = null;
let storageTimer: number | null = null;
let copyFeedbackTimer: number | null = null;
let lastCommittedState: AppState | null = null;
let undoStack: AppState[] = [];
let redoStack: AppState[] = [];
let applyingState = false;
let previewRunning = false;
let midiAccess: MIDIAccess | null = null;
let selectedMidiInput: MIDIInput | null = null;
let heldMidiNotes: number[] = [];
let preferredMidiInputId = "";
let presetsLoaded = false;
let presetPage = 0;
let presetEntries: PresetIndexEntry[] = [];
let currentPlayingCycle: number | null = null;
let activeKnobDrag:
  | {
      input: HTMLInputElement;
      pointerId: number;
      startY: number;
      startValue: number;
      shell: HTMLElement;
    }
  | null = null;

const audio = new WavetableAudio();
audio.onCycle = (cycle) => {
  currentPlayingCycle = cycle;
  updatePositionGhost(cycle);
  requestPlotUpdate();
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

function createDefaultFileName(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `warpenter-wt-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

function setupShell(): void {
  appElement.innerHTML = `
    <dialog class="info-dialog" id="info-dialog" closedby="any">
      <form method="dialog">
        <button class="icon-button dialog-close close-icon" value="cancel" aria-label="Close" title="Close"></button>
      </form>
      <h2>About Warpenter</h2>
      <p>
        Warpenter is an open-source TypeScript wavetable tool inspired by the
        original Lambda Synthetics browser project.
      </p>
      <p>
        If Warpenter helps you make sounds you love, please support Lambda Synthetics
        and the wavetable community that made the original idea possible. More
        wavetable resources are available at
        <a href="https://wavetabl.es" target="_blank" rel="noreferrer">wavetabl.es</a>.
      </p>
      <p>
        <a class="icon-link" href="https://github.com/JimiHFord/warpenter" target="_blank" rel="noreferrer">
          <span class="inline-icon github-icon" aria-hidden="true"></span>
          GitHub repository
        </a>
      </p>
      <h2>FAQ</h2>
      <h3>What file should I export?</h3>
      <p>Most wavetable synths accept mono WAV files with every single-cycle waveform concatenated in order.</p>
      <h3>What does normalize do?</h3>
      <p>Use total normalization for stable overall loudness, per-cycle normalization for even frames, and stretch cycle to remove cycle bias before scaling.</p>
    </dialog>

    <dialog class="info-dialog" id="help-dialog" closedby="any">
      <form method="dialog">
        <button class="icon-button dialog-close close-icon" value="cancel" aria-label="Close" title="Close"></button>
      </form>
      <h2>Keyboard Workflow</h2>
      <p>Use single-key shortcuts unless the file export name field is focused.</p>
      <table class="shortcut-table">
        <tbody>
          <tr><th>J / K</th><td>Select next or previous generator</td></tr>
          <tr><th>N / P</th><td>Select next or previous field inside the selected generator</td></tr>
          <tr><th>E</th><td>Edit the selected field</td></tr>
          <tr><th>U / D</th><td>Move the selected generator up or down</td></tr>
          <tr><th>M</th><td>Mute or unmute the selected generator</td></tr>
          <tr><th>A</th><td>Randomize all active unlocked generators</td></tr>
          <tr><th>G</th><td>Randomize the selected generator</td></tr>
          <tr><th>R</th><td>Randomize the selected row</td></tr>
          <tr><th>V</th><td>Randomize the selected field</td></tr>
          <tr><th>?</th><td>Open this help</td></tr>
        </tbody>
      </table>
      <p>Locks exclude generators, rows, or fields from randomization while leaving them editable.</p>
    </dialog>

    <dialog class="info-dialog" id="save-preset-dialog" closedby="any">
      <form method="dialog">
        <button class="icon-button dialog-close close-icon" value="cancel" aria-label="Close" title="Close"></button>
      </form>
      <h2>Share A Preset</h2>
      <p>
        The preset JSON has been copied to your clipboard. You will need a GitHub account to contribute it.
      </p>
      <p>
        Fork the
        <a href="https://github.com/JimiHFord/warpenter" target="_blank" rel="noreferrer">Warpenter repository</a>,
        add <code id="preset-file-path">public/presets/preset.json</code>, paste this preset into that file, commit it, and open a pull request.
        The preset name and blank description are starter values; please edit them before submitting.
      </p>
      <p>
        The CI pipeline regenerates the preset browser index automatically after merge, so preset pull requests only need the new preset JSON file.
      </p>
      <ol class="preset-steps">
        <li>Fork the repository on GitHub.</li>
        <li>Create <code id="preset-file-name">preset.json</code> in <code>public/presets</code> in your fork.</li>
        <li>Paste the copied JSON, edit the name and optional description, then commit.</li>
        <li>Open a pull request back to Warpenter.</li>
      </ol>
      <p class="button-row copy-feedback-row">
        <button
          id="copy-preset-json-button"
          type="button"
          class="icon-button action-icon copy-icon"
          aria-label="Copy preset JSON"
          title="Copy preset JSON"
        ></button>
        <span id="save-preset-status" class="muted-status" role="status"></span>
      </p>
      <details id="preset-json-details">
        <summary>Current preset JSON</summary>
        <textarea id="save-preset-json" readonly></textarea>
      </details>
    </dialog>

    <div id="flex-center">
      <main>
        <section id="top-flex" class="top-section">
          <div class="top-flex-item">
            <h1>Warpenter <span class="logo" aria-hidden="true">${logoMarkup}</span></h1>
          </div>
          <div class="top-flex-item header-actions">
            <label class="compact-control">
              Theme
              <select id="theme-select">
                ${THEME_OPTIONS.map((theme) => `<option value="${theme.id}">${theme.label}</option>`).join("")}
              </select>
            </label>
            <button
              id="share-button"
              type="button"
              class="icon-button action-icon share-icon"
              aria-label="Share patch"
              title="Copy a URL for the current patch"
            ></button>
            <button
              id="header-save-preset-button"
              type="button"
              class="icon-button action-icon save-icon"
              aria-label="Save preset"
              title="Save preset"
            ></button>
            <button
              id="undo-button"
              type="button"
              class="icon-button action-icon undo-icon"
              aria-label="Undo"
              title="Undo the last edit"
              disabled
            ></button>
            <button
              id="redo-button"
              type="button"
              class="icon-button action-icon redo-icon"
              aria-label="Redo"
              title="Redo the last undone edit"
              disabled
            ></button>
            <button
              id="open-help"
              type="button"
              class="icon-button action-icon help-icon"
              aria-label="Keyboard and randomization help"
              title="Keyboard and randomization help"
            ></button>
            <button
              id="open-info"
              type="button"
              class="icon-button action-icon info-icon"
              aria-label="About Warpenter"
              title="About Warpenter"
            ></button>
          </div>
        </section>

        <div class="main-flex">
          <div class="main-flex-item">
            <section class="designer-section">
              <div class="tab-bar" role="tablist" aria-label="Designer views">
                <button id="generator-tab" class="tab-button" type="button" role="tab" aria-controls="generator-panel" aria-selected="true">Generator</button>
                <button id="presets-tab" class="tab-button" type="button" role="tab" aria-controls="presets-panel" aria-selected="false">Presets</button>
              </div>
              <div id="generator-panel" role="tabpanel" aria-labelledby="generator-tab">
                <h2>Generator</h2>
                <form id="generator-form">
                  <table id="unit-list"></table>

                  <p>
                    <label>
                      Add source / effect:
                      <select id="add-unit-options">
                        <option value="select..." disabled selected>select...</option>
                      </select>
                    </label>
                  </p>

                  <p class="button-row">
                    <span id="render-progress" hidden>generating waveforms</span>
                    <span id="dc-offset-warning" class="color-error" hidden>wavetable contains DC offsets</span>
                  </p>
                </form>
              </div>
              <div id="presets-panel" role="tabpanel" aria-labelledby="presets-tab" hidden>
                <div class="panel-heading">
                  <h2>Presets</h2>
                  <button
                    id="save-preset-button"
                    type="button"
                    class="icon-button action-icon save-icon"
                    aria-label="Save preset"
                    title="Save preset"
                  ></button>
                </div>
                <p id="preset-status" class="muted-status">Open this tab to load available presets.</p>
                <div id="preset-list" class="preset-list"></div>
                <div class="preset-pagination">
                  <button id="preset-prev" type="button">Previous</button>
                  <span id="preset-page-status" class="muted-status"></span>
                  <button id="preset-next" type="button">Next</button>
                </div>
              </div>
            </section>

            <section>
              <h2>File Export</h2>
              <form id="download-form">
                <p>
                  <span id="file-stats">No wavetable generated yet</span>
                </p>
                <p>
                  <label>
                    Name
                    <input type="text" id="file-name" value="${DEFAULT_EXPORT_FILE_NAME}">
                  </label>
                </p>
                <p>
                  <label>
                    Encoding
                    <select id="file-bits">
                      <option value="1" id="file-bits-8">8-bit int</option>
                      <option value="2" id="file-bits-16">16-bit int</option>
                      <option value="4" id="file-bits-32" selected>32-bit float</option>
                    </select>
                  </label>
                </p>
                <p>
                  <label>
                    Format
                    <select id="file-format">
                      <option value="wav" selected>.wav</option>
                      <option value="wt">.wt</option>
                    </select>
                  </label>
                </p>
                <p>
                  <label>
                    <input type="checkbox" id="file-clm">
                    Add clm chunk
                  </label>
                </p>
                <p>
                  <label>
                    <input type="checkbox" id="file-cycle-length" checked>
                    Add cycle length to filename (...-WT<span id="file-cycle-length-example">2048</span>)
                  </label>
                </p>
                <p class="button-row">
                  <button
                    type="button"
                    id="download-button"
                    class="icon-button action-icon download-icon"
                    aria-label="Download wavetable"
                    title="Download wavetable"
                  ></button>
                  <button
                    type="button"
                    id="import-wave-button"
                    class="icon-button action-icon import-icon"
                    aria-label="Import WAV"
                    title="Import WAV generated with this tool"
                  ></button>
                  <input type="file" id="import-wave-input" accept=".wav,audio/wav,audio/wave" hidden>
                </p>
                <p id="import-wave-status" class="muted-status" hidden></p>
              </form>
            </section>
          </div>

          <div class="main-flex-item">
            <section>
              <h2>Audio Preview</h2>
              <form id="preview-form">
                <datalist id="LFO-markers">
                  <option value="0"></option>
                </datalist>
                <div class="knob-grid">
                  <label class="knob-field" data-knob-for="audio-volume">
                    <span>Volume</span>
                    <span class="knob-shell">
                      <span class="knob-face" aria-hidden="true"><span class="knob-pointer"></span></span>
                      <input class="knob-input" type="range" id="audio-volume" value="-36" min="-96" max="0">
                    </span>
                    <output id="audio-volume-output" for="audio-volume"></output>
                  </label>
                  <label class="knob-field" data-knob-for="audio-frequency">
                    <span>Frequency</span>
                    <span class="knob-shell">
                      <span class="knob-face" aria-hidden="true"><span class="knob-pointer"></span></span>
                      <input class="knob-input" type="range" id="audio-frequency" value="6.0313" min="3.0313" max="13.0313" step="any">
                    </span>
                    <output id="audio-frequency-output" for="audio-frequency"></output>
                  </label>
                  <label class="knob-field" data-knob-for="audio-lfo">
                    <span>Position LFO</span>
                    <span class="knob-shell">
                      <span class="knob-face" aria-hidden="true"><span class="knob-pointer"></span></span>
                      <input class="knob-input" type="range" id="audio-lfo" value="32" min="-100" max="100" list="LFO-markers">
                    </span>
                    <output id="audio-lfo-output" for="audio-lfo"></output>
                  </label>
                  <label class="knob-field" data-knob-for="audio-position">
                    <span>Position</span>
                    <span class="knob-shell">
                      <span class="knob-face" aria-hidden="true">
                        <span class="knob-ghost-pointer"></span>
                        <span class="knob-pointer"></span>
                      </span>
                      <input class="knob-input" type="range" id="audio-position" value="0" min="0" max="127">
                    </span>
                    <output id="audio-position-output" for="audio-position"></output>
                  </label>
                </div>
                <div class="preview-options">
                  <label class="compact-control">
                    LFO mode
                    <select id="audio-lfo-mode">
                      <option value="wrap">Wrap</option>
                      <option value="pingpong">Ping-pong</option>
                    </select>
                  </label>
                  <label class="compact-control">
                    MIDI
                    <input type="checkbox" id="midi-enabled">
                  </label>
                  <label class="compact-control midi-input-control">
                    Input
                    <select id="midi-input" disabled>
                      <option value="">No MIDI input</option>
                    </select>
                  </label>
                  <span id="midi-status" class="muted-status">MIDI off</span>
                </div>
                <p class="button-row">
                  <button
                    type="button"
                    id="audio-preview-toggle"
                    class="icon-button transport-button"
                    aria-label="Play preview"
                    aria-pressed="false"
                    title="Play preview"
                  ></button>
                </p>
              </form>
            </section>

            <section>
              <h2>Waveform</h2>
              <details id="details-3d" open>
                <summary>3D</summary>
                <canvas id="waveform-3d-plot" class="waveform-canvas" width="826" height="452"></canvas>
              </details>
              <details id="details-2d" open>
                <summary>2D</summary>
                <canvas id="waveform-2d-plot" class="waveform-canvas" width="826" height="275"></canvas>
              </details>
            </section>
          </div>
        </div>
      </main>
    </div>
  `;
}

function appendGeneratorOptions(): void {
  const unitOptions = byId<HTMLSelectElement>("add-unit-options");
  const sourceGroup = document.createElement("optgroup");
  sourceGroup.label = "sources";
  const effectGroup = document.createElement("optgroup");
  effectGroup.label = "effects";

  for (const definition of sourceDefinitions) {
    const option = document.createElement("option");
    option.value = definition.name;
    option.textContent = definition.name;
    sourceGroup.appendChild(option);
  }

  for (const definition of effectDefinitions) {
    const option = document.createElement("option");
    option.value = definition.name;
    option.textContent = definition.name;
    effectGroup.appendChild(option);
  }

  unitOptions.append(sourceGroup, effectGroup);
}

function appendInitialUnits(patch: DesignerPatch | null): void {
  const unitList = byId<HTMLTableElement>("unit-list");
  const settingsBody = createUnitBody(settingsDefinition, true);
  unitList.appendChild(settingsBody);
  if (patch) {
    applyPatchSettings(settingsBody, patch.state);
  }

  const definitions = [...sourceDefinitions, ...effectDefinitions];
  const patchedUnits = patch?.state.units ?? [];
  const appended = new Set<string>();

  for (const unit of patchedUnits) {
    const definition = findDefinition(unit.name);
    const body = createUnitBody(definition, unit.enabled);
    applyPatchUnit(body, unit);
    unitList.appendChild(body);
    appended.add(unit.name);
  }

  for (const definition of definitions) {
    if (appended.has(definition.name)) {
      continue;
    }
    unitList.appendChild(createUnitBody(definition, definition.enabled === true));
  }
}

function getStartupPatch(): DesignerPatch | null {
  const requested = new URLSearchParams(window.location.search).get("patch");
  if (requested && requested in patches) {
    return patches[requested as keyof typeof patches] ?? null;
  }

  return getConfiguredDefaultPatch();
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: ParameterValue): void {
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    control.checked = Boolean(value);
    return;
  }

  control.value = String(value);
}

function applyPatchSettings(body: HTMLTableSectionElement, state: DesignerState): void {
  const values: Record<string, ParameterValue> = {
    "table size": state.settings.tableSizeBits,
    cycles: state.settings.cycles,
    "fix non-zero start/end": state.settings.fixNonZero,
    normalize: state.settings.normalize,
    "remove duplicates": state.settings.removeDuplicates,
  };

  for (const [name, value] of Object.entries(values)) {
    const control = body.querySelector<HTMLInputElement | HTMLSelectElement>(
      `tr[data-parameter-name="${CSS.escape(name)}"] .linear-start`,
    );
    if (control) {
      setControlValue(control, value);
    }
  }
}

function applyPatchUnit(body: HTMLTableSectionElement, unit: UnitState): void {
  for (const [name, parameter] of Object.entries(unit.parameters)) {
    const row = body.querySelector<HTMLTableRowElement>(`tr[data-parameter-name="${CSS.escape(name)}"]`);
    if (!row) {
      continue;
    }

    const start = row.querySelector<HTMLInputElement | HTMLSelectElement>(".linear-start");
    const end = row.querySelector<HTMLInputElement | HTMLSelectElement>(".linear-end");
    const curve = row.querySelector<HTMLInputElement>(".linear-curve");
    const round = row.querySelector<HTMLInputElement>(".linear-round");

    if (start) {
      setControlValue(start, parameter.start);
    }
    if (end) {
      setControlValue(end, parameter.end);
    }
    if (curve) {
      curve.value = String(parameter.curve);
    }
    if (round) {
      round.checked = parameter.round;
    }
  }
}

function cloneState<T>(state: T): T {
  return JSON.parse(JSON.stringify(state)) as T;
}

function statesEqual(left: AppState | null, right: AppState | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_OPTIONS.some((theme) => theme.id === value);
}

function normalizeAppState(parsed: unknown): AppState | null {
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.designer)) {
    return null;
  }

  const designer = parsed.designer as unknown as DesignerState;
  const audio = isObject(parsed.audio) ? parsed.audio : {};
  const ui = isObject(parsed.ui) ? parsed.ui : {};
  const lfoMode = audio.lfoMode === "pingpong" ? "pingpong" : "wrap";
  const format = ui.fileFormat === "wt" ? "wt" : "wav";
  const bits = ui.fileBits === 1 || ui.fileBits === 2 || ui.fileBits === 4 ? ui.fileBits : 4;

  return {
    version: 1,
    designer,
    audio: {
      volume: Number(audio.volume ?? DEFAULT_AUDIO_STATE.volume),
      frequency: Number(audio.frequency ?? DEFAULT_AUDIO_STATE.frequency),
      lfo: Number(audio.lfo ?? DEFAULT_AUDIO_STATE.lfo),
      lfoMode,
      position: Number(audio.position ?? DEFAULT_AUDIO_STATE.position),
      midiEnabled: Boolean(audio.midiEnabled),
      midiInputId: String(audio.midiInputId ?? ""),
    },
    ui: {
      theme: isThemeId(ui.theme) ? ui.theme : DEFAULT_THEME_ID,
      autoGenerate: true,
      fileName: String(ui.fileName ?? DEFAULT_EXPORT_FILE_NAME),
      fileBits: bits as ExportEncoding,
      fileFormat: format,
      addClmChunk: Boolean(ui.addClmChunk),
      addCycleLength: ui.addCycleLength !== false,
      collapsedUnits: Array.isArray(ui.collapsedUnits)
        ? ui.collapsedUnits.filter((value): value is string => typeof value === "string")
        : [],
      randomizationLocks: normalizeRandomizationLocks(ui.randomizationLocks),
    },
  };
}

function normalizeRandomizationLocks(value: unknown): RandomizationLocks {
  if (!isObject(value)) {
    return { ...EMPTY_RANDOMIZATION_LOCKS };
  }

  return {
    units: Array.isArray(value.units) ? value.units.filter((item): item is string => typeof item === "string") : [],
    rows: Array.isArray(value.rows) ? value.rows.filter((item): item is string => typeof item === "string") : [],
    fields: Array.isArray(value.fields) ? value.fields.filter((item): item is string => typeof item === "string") : [],
  };
}

function loadPersistedState(): AppState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    return normalizeAppState(JSON.parse(raw) as unknown);
  } catch (error) {
    console.warn("Unable to load persisted designer state.", error);
    return null;
  }
}

function loadSharedState(params = new URLSearchParams(window.location.search)): AppState | null {
  const encoded = params.get("state");
  if (!encoded) {
    return null;
  }

  return decodeEncodedAppState(encoded, "shared");
}

function clearSharedStateParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("state")) {
    return;
  }

  url.searchParams.delete("state");
  window.history.replaceState(null, "", url);
}

function decodeEncodedAppState(encoded: string, source: string): AppState | null {
  try {
    const json = decodeBase64Url(encoded);
    return normalizeAppState(JSON.parse(json) as unknown);
  } catch (error) {
    console.warn(`Unable to load ${source} designer state.`, error);
    return null;
  }
}

function encodeShareState(state: AppState): string {
  return encodeBase64Url(JSON.stringify(state));
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = window.atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function schedulePersistState(state = readAppState()): void {
  if (storageTimer !== null) {
    window.clearTimeout(storageTimer);
  }

  const snapshot = cloneState(state);
  storageTimer = window.setTimeout(() => {
    storageTimer = null;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("Unable to persist designer state.", error);
    }
  }, STORAGE_WRITE_DELAY_MS);
}

function readAudioState(): AudioUiState {
  return {
    volume: readAudioControlValue(byId<HTMLInputElement>("audio-volume")),
    frequency: readAudioControlValue(byId<HTMLInputElement>("audio-frequency")),
    lfo: readAudioControlValue(byId<HTMLInputElement>("audio-lfo")),
    lfoMode: byId<HTMLSelectElement>("audio-lfo-mode").value === "pingpong" ? "pingpong" : "wrap",
    position: readAudioControlValue(byId<HTMLInputElement>("audio-position")),
    midiEnabled: byId<HTMLInputElement>("midi-enabled").checked,
    midiInputId: byId<HTMLSelectElement>("midi-input").value || preferredMidiInputId,
  };
}

function readUiState(): UiState {
  const theme = byId<HTMLSelectElement>("theme-select").value;
  return {
    theme: isThemeId(theme) ? theme : DEFAULT_THEME_ID,
    autoGenerate: true,
    fileName: byId<HTMLInputElement>("file-name").value,
    fileBits: Number(byId<HTMLSelectElement>("file-bits").value) as ExportEncoding,
    fileFormat: byId<HTMLSelectElement>("file-format").value as ExportFormat,
    addClmChunk: byId<HTMLInputElement>("file-clm").checked,
    addCycleLength: byId<HTMLInputElement>("file-cycle-length").checked,
    collapsedUnits: readCollapsedUnitKeys(),
    randomizationLocks: readRandomizationLocks(),
  };
}

function readAppState(): AppState {
  return {
    version: 1,
    designer: readState(),
    audio: readAudioState(),
    ui: readUiState(),
  };
}

function applyAppState(state: AppState): void {
  applyingState = true;
  applyDesignerState(state.designer);
  applyAudioState(state.audio);
  applyUiState(state.ui);
  applyingState = false;

  updateAudioParameters();
  updateFileStats();
  updateUndoRedoButtons();
  requestPlotUpdate();
}

function applyDesignerState(state: DesignerState): void {
  const unitList = byId<HTMLTableElement>("unit-list");
  unitList.querySelectorAll("tbody").forEach((body) => body.remove());

  const settingsBody = createUnitBody(settingsDefinition, true);
  applyPatchSettings(settingsBody, state);
  unitList.appendChild(settingsBody);

  for (const unit of state.units) {
    try {
      const definition = findDefinition(unit.name);
      const body = createUnitBody(definition, unit.enabled);
      applyPatchUnit(body, unit);
      unitList.appendChild(body);
    } catch (error) {
      console.warn(`Skipping unknown generator unit "${unit.name}".`, error);
    }
  }
}

function applyAudioState(state: AudioUiState): void {
  byId<HTMLInputElement>("audio-volume").value = String(state.volume);
  byId<HTMLInputElement>("audio-frequency").value = String(state.frequency);
  byId<HTMLInputElement>("audio-lfo").value = String(state.lfo);
  byId<HTMLSelectElement>("audio-lfo-mode").value = state.lfoMode;
  byId<HTMLInputElement>("audio-position").value = String(state.position);
  byId<HTMLInputElement>("midi-enabled").checked = state.midiEnabled;
  preferredMidiInputId = state.midiInputId;
  byId<HTMLSelectElement>("midi-input").value = state.midiInputId;
  updateAllKnobs();
  audio.updateLfoMode(state.lfoMode);
}

function applyUiState(state: UiState): void {
  byId<HTMLSelectElement>("theme-select").value = state.theme;
  applyTheme(state.theme);
  byId<HTMLInputElement>("file-name").value = state.fileName;
  byId<HTMLSelectElement>("file-bits").value = String(state.fileBits);
  byId<HTMLSelectElement>("file-format").value = state.fileFormat;
  byId<HTMLInputElement>("file-clm").checked = state.addClmChunk;
  byId<HTMLInputElement>("file-cycle-length").checked = state.addCycleLength;
  applyCollapsedUnitKeys(state.collapsedUnits);
  applyRandomizationLocks(state.randomizationLocks ?? EMPTY_RANDOMIZATION_LOCKS);
}

function initializeStateTracking(): void {
  lastCommittedState = cloneState(readAppState());
  undoStack = [];
  redoStack = [];
  updateUndoRedoButtons();
  schedulePersistState(lastCommittedState);
}

function commitUserStateChange(): void {
  if (applyingState) {
    return;
  }

  const nextState = readAppState();
  if (!lastCommittedState) {
    lastCommittedState = cloneState(nextState);
    schedulePersistState(nextState);
    updateUndoRedoButtons();
    return;
  }

  if (statesEqual(lastCommittedState, nextState)) {
    schedulePersistState(nextState);
    return;
  }

  undoStack.push(cloneState(lastCommittedState));
  if (undoStack.length > MAX_HISTORY_STATES) {
    undoStack.shift();
  }
  redoStack = [];
  lastCommittedState = cloneState(nextState);
  schedulePersistState(nextState);
  updateUndoRedoButtons();
}

function undoState(): void {
  const previous = undoStack.pop();
  if (!previous) {
    return;
  }

  redoStack.push(cloneState(readAppState()));
  applyAppState(previous);
  lastCommittedState = cloneState(previous);
  schedulePersistState(previous);
  void generate();
}

function redoState(): void {
  const next = redoStack.pop();
  if (!next) {
    return;
  }

  undoStack.push(cloneState(readAppState()));
  applyAppState(next);
  lastCommittedState = cloneState(next);
  schedulePersistState(next);
  void generate();
}

function updateUndoRedoButtons(): void {
  const undo = byId<HTMLButtonElement>("undo-button");
  const redo = byId<HTMLButtonElement>("redo-button");
  undo.disabled = undoStack.length === 0;
  redo.disabled = redoStack.length === 0;
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  requestPlotUpdate();
}

function readCollapsedUnitKeys(): string[] {
  return getGeneratorBodies()
    .map((body, index) => (body.classList.contains("unit-collapsed") ? unitStateKey(body, index) : ""))
    .filter((key) => key.length > 0);
}

function applyCollapsedUnitKeys(keys: string[]): void {
  const collapsed = new Set(keys);
  getGeneratorBodies().forEach((body, index) => {
    setUnitCollapsed(body, collapsed.has(unitStateKey(body, index)));
  });
}

function readRandomizationLocks(): RandomizationLocks {
  return {
    units: getGeneratorBodies()
      .filter((body) => isLockButtonPressed(body.querySelector<HTMLButtonElement>(".unit-lock")))
      .map(unitRandomizationKey),
    rows: Array.from(document.querySelectorAll<HTMLTableRowElement>(".unit-parameter"))
      .filter((row) => isLockButtonPressed(row.querySelector<HTMLButtonElement>(".row-lock")))
      .map(rowRandomizationKey)
      .filter((key): key is string => Boolean(key)),
    fields: Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(FIELD_SELECTOR))
      .filter((control) => isFieldLocked(control))
      .map(fieldRandomizationKey)
      .filter((key): key is string => Boolean(key)),
  };
}

function applyRandomizationLocks(locks: RandomizationLocks): void {
  const unitLocks = new Set(locks.units);
  const rowLocks = new Set(locks.rows);
  const fieldLocks = new Set(locks.fields);

  getGeneratorBodies().forEach((body) => {
    const button = body.querySelector<HTMLButtonElement>(".unit-lock");
    if (button) {
      setLockButtonPressed(button, unitLocks.has(unitRandomizationKey(body)));
    }
  });

  document.querySelectorAll<HTMLTableRowElement>(".unit-parameter").forEach((row) => {
    const button = row.querySelector<HTMLButtonElement>(".row-lock");
    const key = rowRandomizationKey(row);
    if (button) {
      setLockButtonPressed(button, Boolean(key && rowLocks.has(key)));
    }
  });

  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(FIELD_SELECTOR).forEach((control) => {
    const button = fieldLockButton(control);
    const key = fieldRandomizationKey(control);
    if (button) {
      setLockButtonPressed(button, Boolean(key && fieldLocks.has(key)));
    }
  });
}

function isLockButtonPressed(button: HTMLButtonElement | null): boolean {
  return button?.getAttribute("aria-pressed") === "true";
}

function unitRandomizationKey(body: HTMLTableSectionElement): string {
  return body.dataset.unitName ?? "";
}

function rowRandomizationKey(row: HTMLTableRowElement): string | null {
  const body = row.closest<HTMLTableSectionElement>(".unit-body");
  const parameterName = row.dataset.parameterName;
  return body && parameterName ? `${unitRandomizationKey(body)}::${parameterName}` : null;
}

function fieldRandomizationKey(control: HTMLInputElement | HTMLSelectElement): string | null {
  const row = control.closest<HTMLTableRowElement>(".unit-parameter");
  const rowKey = row ? rowRandomizationKey(row) : null;
  const slot = control.dataset.fieldSlot;
  return rowKey && slot ? `${rowKey}::${slot}` : null;
}

function fieldLockButton(control: HTMLInputElement | HTMLSelectElement): HTMLButtonElement | null {
  return control.closest(".field-editor")?.querySelector<HTMLButtonElement>(".field-lock") ?? null;
}

function getGeneratorBodies(): HTMLTableSectionElement[] {
  return Array.from(document.querySelectorAll<HTMLTableSectionElement>(".unit-body")).filter(
    (body) => !body.classList.contains("unit-settings"),
  );
}

function getSelectedUnitBody(): HTMLTableSectionElement | null {
  return document.querySelector<HTMLTableSectionElement>(".unit-body.unit-selected:not(.unit-settings)");
}

function getSelectedFieldControl(): HTMLInputElement | HTMLSelectElement | null {
  return document.querySelector<HTMLInputElement | HTMLSelectElement>(".field-selected");
}

function getSelectedParameterRow(): HTMLTableRowElement | null {
  return (
    document.querySelector<HTMLTableRowElement>(".row-selected") ??
    getSelectedFieldControl()?.closest<HTMLTableRowElement>(".unit-parameter") ??
    null
  );
}

function selectUnitBody(body: HTMLTableSectionElement): void {
  if (body.classList.contains("unit-settings")) {
    return;
  }

  document.querySelectorAll(".unit-selected").forEach((element) => element.classList.remove("unit-selected"));
  document.querySelectorAll(".row-selected").forEach((element) => element.classList.remove("row-selected"));
  document.querySelectorAll(".field-selected").forEach((element) => element.classList.remove("field-selected"));
  body.classList.add("unit-selected");
}

function selectParameterRow(row: HTMLTableRowElement): void {
  const body = row.closest<HTMLTableSectionElement>(".unit-body");
  if (!body || body.classList.contains("unit-settings")) {
    return;
  }

  selectUnitBody(body);
  row.classList.add("row-selected");
}

function selectGeneratorByOffset(offset: number): void {
  const bodies = getGeneratorBodies();
  if (bodies.length === 0) {
    return;
  }

  const selected = getSelectedUnitBody();
  const selectedIndex = selected ? bodies.indexOf(selected) : -1;
  if (selectedIndex === -1) {
    selectUnitBody(bodies[initialGeneratorSelectionIndex(bodies, offset)] as HTMLTableSectionElement);
    return;
  }

  const nextIndex = (selectedIndex + offset + bodies.length) % bodies.length;
  selectUnitBody(bodies[nextIndex] as HTMLTableSectionElement);
}

function initialGeneratorSelectionIndex(bodies: HTMLTableSectionElement[], offset: number): number {
  const activeIndex = bodies.findIndex((body) => body.querySelector<HTMLInputElement>(".unit-enabled")?.checked);
  if (activeIndex !== -1) {
    return activeIndex;
  }

  return offset >= 0 ? 0 : bodies.length - 1;
}

function getFieldControls(body: HTMLTableSectionElement): Array<HTMLInputElement | HTMLSelectElement> {
  return Array.from(body.querySelectorAll<HTMLInputElement | HTMLSelectElement>(FIELD_SELECTOR));
}

function selectFieldControl(control: HTMLInputElement | HTMLSelectElement): void {
  const body = control.closest<HTMLTableSectionElement>(".unit-body");
  const row = control.closest<HTMLTableRowElement>(".unit-parameter");
  if (!body || !row || body.classList.contains("unit-settings")) {
    return;
  }

  selectUnitBody(body);
  selectParameterRow(row);
  control.classList.add("field-selected");
}

function selectFieldByOffset(offset: number): void {
  let body = getSelectedUnitBody();
  if (!body) {
    selectGeneratorByOffset(1);
    body = getSelectedUnitBody();
  }
  if (!body) {
    return;
  }

  const fields = getFieldControls(body);
  if (fields.length === 0) {
    return;
  }

  const selected = getSelectedFieldControl();
  const selectedIndex = selected ? fields.indexOf(selected) : -1;
  const baseIndex = selectedIndex === -1 ? (offset > 0 ? -1 : 0) : selectedIndex;
  const nextIndex = (baseIndex + offset + fields.length) % fields.length;
  selectFieldControl(fields[nextIndex] as HTMLInputElement | HTMLSelectElement);
}

function focusSelectedField(): void {
  const selected = getSelectedFieldControl();
  if (!selected) {
    selectFieldByOffset(1);
  }

  const control = getSelectedFieldControl();
  control?.focus();
  if (control instanceof HTMLInputElement && control.type === "number") {
    control.select();
  }
}

function moveSelectedGenerator(offset: number): void {
  const body = getSelectedUnitBody();
  if (!body || offset === 0) {
    return;
  }

  const bodies = getGeneratorBodies();
  const selectedIndex = bodies.indexOf(body);
  const targetIndex = selectedIndex + offset;
  if (selectedIndex === -1 || targetIndex < 0 || targetIndex >= bodies.length) {
    return;
  }

  if (offset < 0) {
    bodies[targetIndex]?.before(body);
  } else {
    bodies[targetIndex]?.after(body);
  }
  selectUnitBody(body);
  commitUserStateChange();
  queueAutoGenerate();
}

function toggleSelectedGeneratorEnabled(): void {
  const body = getSelectedUnitBody();
  const enabled = body?.querySelector<HTMLInputElement>(".unit-enabled");
  if (!body || !enabled) {
    return;
  }

  enabled.checked = !enabled.checked;
  selectUnitBody(body);
  commitUserStateChange();
  queueAutoGenerate();
}

function randomizeAllActiveGenerators(): void {
  const changed = getGeneratorBodies()
    .filter((body) => body.querySelector<HTMLInputElement>(".unit-enabled")?.checked)
    .reduce((didChange, body) => randomizeUnitBody(body) || didChange, false);
  finishRandomization(changed);
}

function randomizeSelectedGenerator(): void {
  const body = getSelectedUnitBody();
  finishRandomization(Boolean(body && randomizeUnitBody(body)));
}

function randomizeSelectedRow(): void {
  const row = getSelectedParameterRow();
  finishRandomization(Boolean(row && randomizeParameterRow(row)));
}

function randomizeSelectedField(): void {
  const control = getSelectedFieldControl();
  finishRandomization(Boolean(control && randomizeFieldControl(control)));
}

function randomizeUnitBody(body: HTMLTableSectionElement): boolean {
  if (isUnitLocked(body)) {
    return false;
  }

  return Array.from(body.querySelectorAll<HTMLTableRowElement>(".unit-parameter")).reduce(
    (didChange, row) => randomizeParameterRow(row) || didChange,
    false,
  );
}

function randomizeParameterRow(row: HTMLTableRowElement): boolean {
  if (isRowLocked(row)) {
    return false;
  }

  return Array.from(row.querySelectorAll<HTMLInputElement | HTMLSelectElement>(FIELD_SELECTOR)).reduce(
    (didChange, control) => randomizeFieldControl(control) || didChange,
    false,
  );
}

function randomizeFieldControl(control: HTMLInputElement | HTMLSelectElement): boolean {
  const row = control.closest<HTMLTableRowElement>(".unit-parameter");
  const body = control.closest<HTMLTableSectionElement>(".unit-body");
  if (!row || !body || isUnitLocked(body) || isRowLocked(row) || isFieldLocked(control)) {
    return false;
  }

  const before = control instanceof HTMLInputElement && control.type === "checkbox" ? String(control.checked) : control.value;
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    control.checked = Math.random() >= 0.5;
  } else if (control instanceof HTMLSelectElement) {
    const optionCount = control.options.length;
    control.value = String(Math.min(optionCount - 1, Math.floor(Math.random() * optionCount)));
  } else {
    control.value = String(randomNumericControlValue(control));
  }

  const after = control instanceof HTMLInputElement && control.type === "checkbox" ? String(control.checked) : control.value;
  return before !== after;
}

function randomNumericControlValue(control: HTMLInputElement): number {
  const min = Number.isFinite(Number(control.min)) && control.min !== "" ? Number(control.min) : fallbackMinimum(control);
  const max = Number.isFinite(Number(control.max)) && control.max !== "" ? Number(control.max) : fallbackMaximum(control, min);
  const raw = min + Math.random() * (max - min);
  if (Number.isInteger(min) && Number.isInteger(max)) {
    return Math.round(raw);
  }

  return Math.round(raw * 1000) / 1000;
}

function fallbackMinimum(control: HTMLInputElement): number {
  return control.classList.contains("linear-curve") ? -100 : 0;
}

function fallbackMaximum(control: HTMLInputElement, min: number): number {
  const current = Number(control.value);
  if (control.classList.contains("linear-curve")) {
    return 100;
  }
  if (Number.isFinite(current) && current > min) {
    return Math.max(current * 4, min + 1);
  }
  return min + 256;
}

function isUnitLocked(body: HTMLTableSectionElement): boolean {
  return isLockButtonPressed(body.querySelector<HTMLButtonElement>(".unit-lock"));
}

function isRowLocked(row: HTMLTableRowElement): boolean {
  return isLockButtonPressed(row.querySelector<HTMLButtonElement>(".row-lock"));
}

function isFieldLocked(control: HTMLInputElement | HTMLSelectElement): boolean {
  return isLockButtonPressed(fieldLockButton(control));
}

function finishRandomization(changed: boolean): void {
  if (!changed) {
    return;
  }

  commitUserStateChange();
  queueAutoGenerate();
}

function unitStateKey(body: HTMLTableSectionElement, index: number): string {
  return `${index}:${body.dataset.unitName ?? ""}`;
}

function setUnitCollapsed(body: HTMLTableSectionElement, collapsed: boolean): void {
  body.classList.toggle("unit-collapsed", collapsed);
  const button = body.querySelector<HTMLButtonElement>(".unit-collapse");
  if (!button) {
    return;
  }

  const name = body.dataset.unitName ?? "generator";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", collapsed ? `Expand ${name}` : `Collapse ${name}`);
  button.title = collapsed ? `Expand ${name}` : `Collapse ${name}`;
}

function createUnitBody(definition: UnitDefinition, enabled: boolean): HTMLTableSectionElement {
  const tbody = document.createElement("tbody");
  tbody.classList.add("unit-body", definition.kind);
  tbody.dataset.unitName = definition.name;
  tbody.dataset.unitKind = definition.kind;
  tbody.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || tbody.classList.contains("unit-settings")) {
      return;
    }

    const control = target.closest<HTMLInputElement | HTMLSelectElement>(FIELD_SELECTOR);
    if (control) {
      selectFieldControl(control);
      return;
    }

    selectUnitBody(tbody);
  });

  if (definition.kind === "settings") {
    tbody.classList.add("unit-settings");
  }

  const header = tbody.insertRow();
  header.className = "unit-header-row";
  const enableCell = header.insertCell();
  enableCell.className = "unit-enable-cell";
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.className = "unit-enabled";
  enabledInput.checked = enabled;
  if (definition.kind === "settings") {
    enabledInput.style.visibility = "hidden";
  }
  enableCell.appendChild(enabledInput);

  const nameCell = header.insertCell();
  nameCell.className = "unit-name-row";
  const nameWrap = document.createElement("span");
  nameWrap.className = "unit-name-wrap";

  if (definition.kind !== "settings") {
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "icon-button unit-collapse";
    collapse.setAttribute("aria-expanded", "true");
    collapse.setAttribute("aria-label", `Collapse ${definition.name}`);
    collapse.title = `Collapse ${definition.name}`;
    collapse.addEventListener("click", () => {
      setUnitCollapsed(tbody, !tbody.classList.contains("unit-collapsed"));
      commitUserStateChange();
    });
    nameWrap.appendChild(collapse);
  }

  const name = document.createElement("span");
  name.className = definition.kind === "settings" ? "unit-name" : "unit-name drag-handle";
  name.textContent = definition.name;
  if (definition.kind === "effects") {
    const small = document.createElement("small");
    small.textContent = " (fx)";
    name.appendChild(small);
  }
  nameWrap.appendChild(name);

  if (definition.kind !== "settings") {
    nameWrap.appendChild(createLockButton("unit-lock", `Lock ${definition.name} against randomization`));
  }

  nameCell.appendChild(nameWrap);

  const deleteCell = header.insertCell();
  deleteCell.className = "unit-actions";
  if (definition.kind === "settings") {
    deleteCell.textContent = "";
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button unit-delete";
    button.setAttribute("aria-label", `Remove ${definition.name}`);
    button.title = `Remove ${definition.name}`;
    button.addEventListener("click", () => {
      tbody.remove();
      commitUserStateChange();
      queueAutoGenerate();
    });
    deleteCell.appendChild(button);
  }

  if (definition.kind !== "settings") {
    tbody.appendChild(createFieldLabelRow());
  }

  for (const [parameterName, spec] of Object.entries(definition.parameters)) {
    tbody.appendChild(createParameterRow(definition.kind, parameterName, spec));
  }

  const dropZone = tbody.insertRow();
  dropZone.className = "drop-zone";
  const cell = dropZone.insertCell();
  cell.colSpan = 3;

  if (definition.kind !== "settings") {
    initDragEvents(tbody);
  }

  return tbody;
}

function createFieldLabelRow(): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "unit-field-label-row";

  const spacerCell = row.insertCell();
  spacerCell.className = "parameter-spacer";

  const labelCell = row.insertCell();
  labelCell.colSpan = 2;
  labelCell.className = "parameter-editor-cell";

  const labelGrid = document.createElement("div");
  labelGrid.className = "parameter-editor-row field-column-labels";
  const parameterHeading = document.createElement("span");
  parameterHeading.className = "parameter-label-heading";
  labelGrid.appendChild(parameterHeading);

  ["Start", "End", "Curve", "Round"].forEach((labelText) => {
    const label = document.createElement("span");
    label.className = "field-column-label";
    label.textContent = labelText;
    labelGrid.appendChild(label);
  });

  labelCell.appendChild(labelGrid);
  return row;
}

function createParameterRow(kind: UnitDefinition["kind"], parameterName: string, spec: ParameterSpec): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "unit-parameter";
  row.dataset.parameterName = parameterName;

  const spacerCell = row.insertCell();
  spacerCell.className = "parameter-spacer";

  const editorCell = row.insertCell();
  editorCell.colSpan = 2;
  editorCell.className = kind === "settings" ? "settings-editor-cell" : "parameter-editor-cell";
  const editorRow = document.createElement("div");
  editorRow.className = kind === "settings" ? "settings-editor-row" : "parameter-editor-row";
  editorCell.appendChild(editorRow);

  const labelGroup = document.createElement("div");
  labelGroup.className = "parameter-label-group";
  if (kind !== "settings") {
    labelGroup.appendChild(createLockButton("row-lock", `Lock ${parameterName} row against randomization`));
  }

  const label = document.createElement("span");
  label.className = "parameter-name";
  label.textContent = spec.type ? `${parameterName} (${spec.type})` : parameterName;
  labelGroup.appendChild(label);
  editorRow.appendChild(labelGroup);

  const startControl = createValueControl(spec, "linear-start");
  if (kind === "settings") {
    editorRow.appendChild(createFieldEditor(startControl, "start", false, parameterName));
    return row;
  }

  editorRow.appendChild(createFieldEditor(startControl, "start", true, `${parameterName} start`));

  const endControl = createValueControl(spec, "linear-end");
  editorRow.appendChild(createFieldEditor(endControl, "end", true, `${parameterName} end`));

  const curve = document.createElement("input");
  curve.type = "number";
  curve.step = "any";
  curve.required = true;
  curve.min = "-100";
  curve.max = "100";
  curve.value = "0";
  curve.className = "linear-input linear-curve";
  editorRow.appendChild(createFieldEditor(curve, "curve", true, `${parameterName} curve`));

  const round = document.createElement("input");
  round.type = "checkbox";
  round.className = "linear-input linear-round";
  editorRow.appendChild(createFieldEditor(round, "round", true, `${parameterName} round`));
  return row;
}

function createFieldEditor(
  control: HTMLInputElement | HTMLSelectElement,
  slot: string,
  lockable: boolean,
  accessibleLabel: string,
): HTMLDivElement {
  control.dataset.fieldSlot = slot;
  control.setAttribute("aria-label", accessibleLabel);
  const editor = document.createElement("div");
  editor.className = lockable
    ? `field-editor field-cell has-field-lock field-editor-${slot}`
    : `field-editor field-cell field-editor-${slot}`;
  editor.appendChild(control);
  if (lockable) {
    editor.appendChild(createLockButton("field-lock", `Lock ${slot} field against randomization`));
  }
  return editor;
}

function createLockButton(className: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button action-icon lock-icon ${className}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  setLockButtonPressed(button, false);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleRandomizationLock(button);
  });
  return button;
}

function handleGeneratorFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const control = target.closest<HTMLInputElement | HTMLSelectElement>(FIELD_SELECTOR);
  if (control) {
    selectFieldControl(control);
    return;
  }

  const fieldEditor = target.closest<HTMLElement>(".field-editor");
  const fieldControl = fieldEditor?.querySelector<HTMLInputElement | HTMLSelectElement>(FIELD_SELECTOR);
  if (fieldControl) {
    selectFieldControl(fieldControl);
    return;
  }

  const row = target.closest<HTMLTableRowElement>(".unit-parameter");
  if (row) {
    selectParameterRow(row);
    return;
  }

  const body = target.closest<HTMLTableSectionElement>(".unit-body");
  if (body) {
    selectUnitBody(body);
  }
}

function toggleRandomizationLock(button: HTMLButtonElement): void {
  setLockButtonPressed(button, button.getAttribute("aria-pressed") !== "true");
  commitUserStateChange();
}

function setLockButtonPressed(button: HTMLButtonElement, locked: boolean): void {
  button.setAttribute("aria-pressed", String(locked));
  button.classList.toggle("is-locked", locked);
  const label = button.getAttribute("aria-label") ?? "Lock randomization";
  const nextLabel = locked ? label.replace(/^Lock /, "Unlock ") : label.replace(/^Unlock /, "Lock ");
  button.setAttribute("aria-label", nextLabel);
  button.title = nextLabel;
}

function createValueControl(spec: ParameterSpec, className: string): HTMLInputElement | HTMLSelectElement {
  if (spec.options) {
    const select = document.createElement("select");
    select.className = `linear-input ${className}`;
    spec.options.forEach((label, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = String(spec.default);
    return select;
  }

  const input = document.createElement("input");
  input.className = `linear-input ${className}`;

  if (typeof spec.default === "boolean") {
    input.type = "checkbox";
    input.checked = spec.default;
    return input;
  }

  input.type = "number";
  input.step = "any";
  input.required = true;
  input.value = String(spec.default);

  if (typeof spec.min === "number") {
    input.min = String(spec.min);
  }
  if (typeof spec.max === "number") {
    input.max = String(spec.max);
  }

  return input;
}

function initDragEvents(tbody: HTMLTableSectionElement): void {
  const handle = tbody.querySelector<HTMLElement>(".drag-handle");
  if (!handle) {
    return;
  }

  handle.draggable = true;
  handle.addEventListener("dragstart", (event) => {
    draggingBody = tbody;
    event.dataTransfer?.setData("text/plain", tbody.dataset.unitName ?? "");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  });

  handle.addEventListener("dragend", () => {
    draggingBody = null;
    clearDropFocus();
  });
}

function initDropEvents(): void {
  const unitList = byId<HTMLTableElement>("unit-list");

  unitList.addEventListener("dragover", (event) => {
    event.preventDefault();
    const nearest = getNearestDropZone(event.clientY);
    clearDropFocus();
    nearest?.classList.add("drop-zone-focus");
  });

  unitList.addEventListener("drop", (event) => {
    event.preventDefault();
    const nearest = getNearestDropZone(event.clientY);
    if (!nearest || !draggingBody) {
      return;
    }

    const targetBody = nearest.closest<HTMLTableSectionElement>(".unit-body");
    if (!targetBody || targetBody.classList.contains("unit-settings")) {
      return;
    }

    targetBody.after(draggingBody);
    draggingBody = null;
    clearDropFocus();
    commitUserStateChange();
    queueAutoGenerate();
  });
}

function getNearestDropZone(yPos: number): HTMLTableRowElement | null {
  let nearest: HTMLTableRowElement | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;

  document.querySelectorAll<HTMLTableRowElement>(".drop-zone").forEach((element) => {
    const parent = element.closest(".unit-body");
    if (parent?.classList.contains("unit-settings")) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const dist = Math.abs(y - yPos);
    if (dist < nearestDist) {
      nearest = element;
      nearestDist = dist;
    }
  });

  return nearest;
}

function clearDropFocus(): void {
  document.querySelectorAll(".drop-zone-focus").forEach((element) => element.classList.remove("drop-zone-focus"));
}

function controlValue(control: HTMLInputElement | HTMLSelectElement): ParameterValue {
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    return control.checked;
  }

  return Number(control.value);
}

function readState(): DesignerState {
  const settingsBody = byId<HTMLTableElement>("unit-list").querySelector<HTMLTableSectionElement>(".unit-settings");
  if (!settingsBody) {
    throw new Error("Missing settings unit");
  }

  const getSetting = (name: string): ParameterValue => {
    const row = settingsBody.querySelector<HTMLTableRowElement>(`tr[data-parameter-name="${CSS.escape(name)}"]`);
    const control = row?.querySelector<HTMLInputElement | HTMLSelectElement>(".linear-start");
    if (!control) {
      throw new Error(`Missing setting ${name}`);
    }
    return controlValue(control);
  };

  const tableSizeBits = Number(getSetting("table size"));
  const settings = {
    tableSizeBits,
    tableSize: Math.pow(2, tableSizeBits),
    cycles: Number(getSetting("cycles")),
    fixNonZero: Boolean(getSetting("fix non-zero start/end")),
    normalize: Number(getSetting("normalize")) as NormalizeMode,
    removeDuplicates: Boolean(getSetting("remove duplicates")),
  };

  const units = Array.from(document.querySelectorAll<HTMLTableSectionElement>(".unit-body"))
    .filter((body) => !body.classList.contains("unit-settings"))
    .map(readUnit);

  return { settings, units };
}

function readUnit(body: HTMLTableSectionElement): UnitState {
  const name = body.dataset.unitName;
  const kind = body.dataset.unitKind;
  if (!name || (kind !== "sources" && kind !== "effects")) {
    throw new Error("Invalid unit in generator table");
  }

  const enabled = body.querySelector<HTMLInputElement>(".unit-enabled")?.checked ?? false;
  const parameters: Record<string, MorphedParameter> = {};
  findDefinition(name);

  body.querySelectorAll<HTMLTableRowElement>(".unit-parameter").forEach((row) => {
    const parameterName = row.dataset.parameterName;
    const start = row.querySelector<HTMLInputElement | HTMLSelectElement>(".linear-start");
    const end = row.querySelector<HTMLInputElement | HTMLSelectElement>(".linear-end");
    const curve = row.querySelector<HTMLInputElement>(".linear-curve");
    const round = row.querySelector<HTMLInputElement>(".linear-round");

    if (!parameterName || !start || !end || !curve || !round) {
      return;
    }

    parameters[parameterName] = {
      start: controlValue(start),
      end: controlValue(end),
      curve: Number(curve.value),
      round: round.checked,
    };
  });

  return { name, kind, enabled, parameters };
}

async function generate(): Promise<void> {
  const form = document.getElementById("generator-form") as HTMLFormElement | null;
  if (!form) {
    return;
  }
  if (!form.reportValidity()) {
    return;
  }

  byId("dc-offset-warning").setAttribute("hidden", "");
  byId("render-progress").removeAttribute("hidden");
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const result = await renderWasmWavetable(readState());
  waveTables = result.tables;
  byId("render-progress").setAttribute("hidden", "");

  if (result.containsDcOffset) {
    byId("dc-offset-warning").removeAttribute("hidden");
  } else {
    byId("dc-offset-warning").setAttribute("hidden", "");
  }

  const position = byId<HTMLInputElement>("audio-position");
  position.min = "0";
  position.max = String(Math.max(0, waveTables.length - 1));
  position.value = String(Math.min(Number(position.value), Math.max(0, waveTables.length - 1)));
  updateKnobVisual(position);

  audio.updateTables(waveTables);
  updateFileStats();
  schedulePersistState();
  requestPlotUpdate();
}

function queueAutoGenerate(): void {
  if (generateTimer !== null) {
    window.clearTimeout(generateTimer);
  }

  generateTimer = window.setTimeout(() => {
    generateTimer = null;
    void generate();
  }, 150);
}

function updateFileStats(): void {
  const format = byId<HTMLSelectElement>("file-format").value as ExportFormat;
  const bits = byId<HTMLSelectElement>("file-bits");
  const clm = byId<HTMLInputElement>("file-clm");

  if (format === "wt") {
    clm.checked = false;
    clm.disabled = true;
    byId<HTMLOptionElement>("file-bits-8").disabled = true;
    if (bits.value === "1") {
      bits.value = "2";
    }
  } else {
    clm.disabled = false;
    byId<HTMLOptionElement>("file-bits-8").disabled = false;
  }

  const firstTable = waveTables[0];
  if (!firstTable) {
    return;
  }

  const totalSamples = firstTable.length * waveTables.length;
  const bytesPerSample = Number(bits.value);
  const totalSize = formatReadableBytes(totalSamples * bytesPerSample + 44);
  byId("file-stats").textContent = `${firstTable.length} samples x ${waveTables.length} cycle(s) = ${totalSize}`;
  byId("file-cycle-length-example").textContent = String(firstTable.length);
}

async function downloadCurrent(): Promise<void> {
  await generate();
  if (waveTables.length === 0) {
    return;
  }

  const format = byId<HTMLSelectElement>("file-format").value as ExportFormat;
  const encoding = Number(byId<HTMLSelectElement>("file-bits").value) as ExportEncoding;
  let filename = byId<HTMLInputElement>("file-name").value.trim() || DEFAULT_EXPORT_FILE_NAME;

  if (byId<HTMLInputElement>("file-cycle-length").checked) {
    filename += `-WT${waveTables[0]?.length ?? 0}`;
  }
  filename += `.${format}`;

  let buffer = (await renderWasmExport({
    encoding,
    format,
    addClmChunk: byId<HTMLInputElement>("file-clm").checked,
  })) ?? encodeWavetable({
    tables: waveTables,
    encoding,
    format,
    addClmChunk: byId<HTMLInputElement>("file-clm").checked,
  });
  if (format === "wav") {
    buffer = attachWavetableStateMetadata(buffer, encodeShareState(readAppState()));
  }
  const blob = new Blob([buffer], { type: format === "wav" ? "audio/wav" : "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function setImportWaveStatus(message: string, isError: boolean): void {
  const status = byId("import-wave-status");
  status.textContent = message;
  status.hidden = false;
  status.classList.toggle("color-error", isError);
  status.classList.toggle("muted-status", !isError);
}

function clearImportWaveStatus(): void {
  const status = byId("import-wave-status");
  status.textContent = "";
  status.hidden = true;
  status.classList.remove("color-error");
  status.classList.add("muted-status");
}

async function importWaveFile(file: File | null): Promise<void> {
  clearImportWaveStatus();
  if (!file) {
    return;
  }

  const unsupportedMessage = "Only WAV files generated with this tool are supported.";
  try {
    const encodedState = extractWavetableStateMetadata(await file.arrayBuffer());
    const importedState = encodedState ? decodeEncodedAppState(encodedState, "imported WAV metadata") : null;
    if (!importedState) {
      setImportWaveStatus(unsupportedMessage, true);
      return;
    }

    applyAppState(importedState);
    const importedSnapshot = cloneState(readAppState());
    lastCommittedState = importedSnapshot;
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    schedulePersistState(importedSnapshot);
    setImportWaveStatus("Imported state from WAV metadata.", false);
    await generate();
  } catch (error) {
    console.warn("Unable to import WAV metadata.", error);
    setImportWaveStatus(unsupportedMessage, true);
  }
}

async function shareCurrentState(): Promise<void> {
  commitUserStateChange();
  const url = new URL(window.location.href);
  url.searchParams.set("state", encodeShareState(readAppState()));

  const button = byId<HTMLButtonElement>("share-button");
  const originalLabel = button.getAttribute("aria-label") ?? "Share patch";
  const originalTitle = button.title;
  button.classList.add("action-feedback");
  try {
    if (!navigator.clipboard) {
      throw new Error("Clipboard unavailable");
    }
    await navigator.clipboard.writeText(url.toString());
    button.setAttribute("aria-label", "Share link copied");
    button.title = "Copied";
  } catch {
    button.setAttribute("aria-label", "Share link ready");
    button.title = "Share link ready";
  }

  window.setTimeout(() => {
    button.classList.remove("action-feedback");
    button.setAttribute("aria-label", originalLabel);
    button.title = originalTitle;
  }, 1600);
}

function showDesignerTab(tab: "generator" | "presets"): void {
  const generatorSelected = tab === "generator";
  byId<HTMLButtonElement>("generator-tab").setAttribute("aria-selected", String(generatorSelected));
  byId<HTMLButtonElement>("presets-tab").setAttribute("aria-selected", String(!generatorSelected));
  byId<HTMLElement>("generator-panel").hidden = !generatorSelected;
  byId<HTMLElement>("presets-panel").hidden = generatorSelected;
}

async function ensurePresetsLoaded(): Promise<void> {
  if (presetsLoaded) {
    renderPresetPage();
    return;
  }

  const status = byId("preset-status");
  status.textContent = "Loading presets...";
  try {
    const response = await fetch(presetAssetUrl("index.json"));
    if (!response.ok) {
      throw new Error(`Preset index returned ${response.status}`);
    }

    const parsed = (await response.json()) as { presets?: unknown };
    presetEntries = Array.isArray(parsed.presets)
      ? parsed.presets
          .filter(isPresetIndexEntry)
          .map((entry) => ({ ...entry, description: entry.description ?? "" }))
      : [];
    presetsLoaded = true;
    presetPage = 0;
    renderPresetPage();
  } catch (error) {
    console.warn("Unable to load presets.", error);
    status.textContent = "Unable to load presets.";
    status.classList.add("color-error");
  }
}

function isPresetIndexEntry(value: unknown): value is PresetIndexEntry {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.modified === undefined || typeof value.modified === "string") &&
    (value.author === undefined || typeof value.author === "string") &&
    (value.authorUrl === undefined || typeof value.authorUrl === "string")
  );
}

function renderPresetPage(): void {
  const list = byId("preset-list");
  const status = byId("preset-status");
  const pageStatus = byId("preset-page-status");
  const previous = byId<HTMLButtonElement>("preset-prev");
  const next = byId<HTMLButtonElement>("preset-next");
  list.innerHTML = "";

  if (presetEntries.length === 0) {
    status.textContent = "No presets are available yet.";
    pageStatus.textContent = "";
    previous.disabled = true;
    next.disabled = true;
    return;
  }

  status.textContent = "Choose a preset to load it into the generator.";
  status.classList.remove("color-error");
  const pageCount = Math.max(1, Math.ceil(presetEntries.length / PRESET_PAGE_SIZE));
  presetPage = Math.min(Math.max(presetPage, 0), pageCount - 1);
  const pageStart = presetPage * PRESET_PAGE_SIZE;
  const pageEntries = presetEntries.slice(pageStart, pageStart + PRESET_PAGE_SIZE);

  for (const preset of pageEntries) {
    const item = document.createElement("article");
    item.className = "preset-card";

    const title = document.createElement("h3");
    title.textContent = preset.name;
    item.appendChild(title);

    if (preset.description) {
      const description = document.createElement("p");
      description.textContent = preset.description;
      item.appendChild(description);
    }

    if (preset.author || preset.modified) {
      const metadata = document.createElement("p");
      metadata.className = "preset-metadata";
      const parts: string[] = [];
      if (preset.author) {
        parts.push(`by ${preset.author}`);
      }
      if (preset.modified) {
        parts.push(`updated ${formatPresetDate(preset.modified)}`);
      }

      if (preset.author && preset.authorUrl) {
        const authorLink = document.createElement("a");
        authorLink.href = preset.authorUrl;
        authorLink.target = "_blank";
        authorLink.rel = "noreferrer";
        authorLink.textContent = preset.author;
        metadata.append("by ", authorLink);
        if (preset.modified) {
          metadata.append(` · updated ${formatPresetDate(preset.modified)}`);
        }
      } else {
        metadata.textContent = parts.join(" · ");
      }
      item.appendChild(metadata);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-load";
    button.textContent = "Load";
    button.addEventListener("click", () => void loadPreset(preset));
    item.appendChild(button);
    list.appendChild(item);
  }

  pageStatus.textContent = `Page ${presetPage + 1} of ${pageCount}`;
  previous.disabled = presetPage === 0;
  next.disabled = presetPage >= pageCount - 1;
}

function formatPresetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function changePresetPage(direction: number): void {
  presetPage += direction;
  renderPresetPage();
}

async function loadPreset(entry: PresetIndexEntry): Promise<void> {
  const status = byId("preset-status");
  status.textContent = `Loading ${entry.name}...`;
  try {
    const previousState = cloneState(readAppState());
    const response = await fetch(presetAssetUrl(entry.path));
    if (!response.ok) {
      throw new Error(`Preset returned ${response.status}`);
    }
    const preset = (await response.json()) as PresetDocument;
    applyDesignerState(preset.state);
    applyRandomizationLocks(previousState.ui.randomizationLocks);
    commitUserStateChange();
    status.textContent = `Loaded ${preset.name || entry.name}.`;
    void generate();
  } catch (error) {
    console.warn("Unable to load preset.", error);
    status.textContent = `Unable to load ${entry.name}.`;
    status.classList.add("color-error");
  }
}

function presetAssetUrl(path: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${base}presets/${path}`;
}

async function openSavePresetDialog(): Promise<void> {
  const textarea = byId<HTMLTextAreaElement>("save-preset-json");
  const draft = createPresetDraft();
  const fileName = `${draft.id}.json`;
  textarea.value = JSON.stringify(draft, null, 2);
  byId("preset-file-name").textContent = fileName;
  byId("preset-file-path").textContent = `public/presets/${fileName}`;
  byId<HTMLDetailsElement>("preset-json-details").open = false;
  clearCopyFeedback();
  byId<HTMLDialogElement>("save-preset-dialog").showModal();
  await copyPresetJsonToClipboard();
}

function createPresetDraft(): PresetDocument & {
  description: string;
  author: { name: string; github: string };
} {
  return {
    id: createUuidV4(),
    name: createRandomPresetName(),
    description: "",
    author: {
      name: "",
      github: "",
    },
    state: readState(),
  };
}

function createUuidV4(): string {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (character) => {
    const value = Number(character);
    const randomByte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
    return (value ^ (randomByte & (15 >> (value / 4)))).toString(16);
  });
}

function createRandomPresetName(): string {
  const adjective = PRESET_ADJECTIVES[Math.floor(Math.random() * PRESET_ADJECTIVES.length)] ?? "Neon";
  const noun = PRESET_NOUNS[Math.floor(Math.random() * PRESET_NOUNS.length)] ?? "Pulse";
  return `${adjective} ${noun}`;
}

async function copyPresetJsonToClipboard(): Promise<void> {
  const textarea = byId<HTMLTextAreaElement>("save-preset-json");
  try {
    if (!navigator.clipboard) {
      throw new Error("Clipboard unavailable");
    }
    await navigator.clipboard.writeText(textarea.value);
    showCopyFeedback("Copied JSON to clipboard.", false);
  } catch {
    showCopyFeedback("Clipboard copy unavailable. Open the JSON section and copy manually.", true);
  }
}

function showCopyFeedback(message: string, isError: boolean): void {
  const status = byId("save-preset-status");
  if (copyFeedbackTimer !== null) {
    window.clearTimeout(copyFeedbackTimer);
  }
  status.textContent = message;
  status.classList.toggle("color-error", isError);
  status.classList.toggle("muted-status", !isError);
  copyFeedbackTimer = window.setTimeout(() => {
    status.textContent = "";
    copyFeedbackTimer = null;
  }, 1600);
}

function clearCopyFeedback(): void {
  if (copyFeedbackTimer !== null) {
    window.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }
  const status = document.getElementById("save-preset-status");
  if (status) {
    status.textContent = "";
  }
}

function requestPlotUpdate(): void {
  plotUpdateRequested = true;
}

function plotLoop(): void {
  if (plotUpdateRequested && waveTables.length > 0) {
    const selected = currentVisualizerCycle();

    if (byId<HTMLDetailsElement>("details-3d").open) {
      plotTable3D(byId<HTMLCanvasElement>("waveform-3d-plot"), waveTables, selected);
    }
    if (byId<HTMLDetailsElement>("details-2d").open) {
      plotTable2D(byId<HTMLCanvasElement>("waveform-2d-plot"), waveTables, selected);
    }

    plotUpdateRequested = false;
  }

  requestAnimationFrame(plotLoop);
}

function currentVisualizerCycle(): number {
  if (isPositionDragActive()) {
    return Number(byId<HTMLInputElement>("audio-position").value);
  }
  if (isAudioPlaying() && currentPlayingCycle !== null) {
    return currentPlayingCycle;
  }
  return Number(byId<HTMLInputElement>("audio-position").value);
}

function isAudioPlaying(): boolean {
  return previewRunning || heldMidiNotes.length > 0;
}

function isPositionDragActive(): boolean {
  return activeKnobDrag?.input.id === "audio-position";
}

function installEventHandlers(): void {
  byId("open-info").addEventListener("click", () => byId<HTMLDialogElement>("info-dialog").showModal());
  byId("open-help").addEventListener("click", () => byId<HTMLDialogElement>("help-dialog").showModal());
  byId("share-button").addEventListener("click", () => void shareCurrentState());
  byId("header-save-preset-button").addEventListener("click", () => void openSavePresetDialog());
  byId("undo-button").addEventListener("click", undoState);
  byId("redo-button").addEventListener("click", redoState);
  byId("generator-tab").addEventListener("click", () => showDesignerTab("generator"));
  byId("presets-tab").addEventListener("click", () => {
    showDesignerTab("presets");
    void ensurePresetsLoaded();
  });
  byId("save-preset-button").addEventListener("click", () => void openSavePresetDialog());
  byId("copy-preset-json-button").addEventListener("click", () => void copyPresetJsonToClipboard());
  byId("preset-prev").addEventListener("click", () => changePresetPage(-1));
  byId("preset-next").addEventListener("click", () => changePresetPage(1));

  byId<HTMLSelectElement>("theme-select").addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    applyTheme(isThemeId(target.value) ? target.value : DEFAULT_THEME_ID);
    commitUserStateChange();
  });

  byId<HTMLFormElement>("generator-form").addEventListener("submit", (event) => {
    event.preventDefault();
    commitUserStateChange();
    void generate();
  });

  byId<HTMLFormElement>("generator-form").addEventListener("focusin", handleGeneratorFocusIn);

  byId<HTMLFormElement>("generator-form").addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.id === "add-unit-options") {
      const definition = findDefinition(target.value);
      byId<HTMLTableElement>("unit-list").appendChild(createUnitBody(definition, true));
      target.selectedIndex = 0;
    }
    commitUserStateChange();
    queueAutoGenerate();
  });

  byId<HTMLFormElement>("generator-form").addEventListener("input", () => {
    schedulePersistState();
    queueAutoGenerate();
  });

  byId<HTMLFormElement>("download-form").addEventListener("change", () => {
    updateFileStats();
    commitUserStateChange();
  });
  byId("download-button").addEventListener("click", () => void downloadCurrent());
  byId("import-wave-button").addEventListener("click", () => byId<HTMLInputElement>("import-wave-input").click());
  byId<HTMLInputElement>("import-wave-input").addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    void importWaveFile(target.files?.[0] ?? null).finally(() => {
      target.value = "";
    });
  });

  byId("audio-preview-toggle").addEventListener("click", () => void toggleAudioPreview());

  byId<HTMLFormElement>("preview-form").addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.id.startsWith("audio-")) {
      return;
    }

    updateAudioParameterFromInput(target);
    if (target.id === "audio-position") {
      requestPlotUpdate();
    }
    updateKnobVisual(target);
    schedulePersistState();
  });

  byId<HTMLFormElement>("preview-form").addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.id === "audio-lfo-mode") {
      audio.updateLfoMode(target.value === "pingpong" ? "pingpong" : "wrap");
    }
    if (target instanceof HTMLInputElement && target.id === "midi-enabled") {
      void setMidiEnabled(target.checked).then(commitUserStateChange);
      return;
    }
    if (target instanceof HTMLSelectElement && target.id === "midi-input") {
      preferredMidiInputId = target.value;
      connectSelectedMidiInput();
      setMidiStatus(selectedMidiInput ? `Listening to ${selectedMidiInput.name ?? "MIDI input"}` : "No MIDI input");
    }
    commitUserStateChange();
  });
  installKnobDragHandlers();
  window.addEventListener("pointerup", finishKnobPointerDrag);
  window.addEventListener("pointercancel", finishKnobPointerDrag);

  byId<HTMLDetailsElement>("details-3d").addEventListener("toggle", requestPlotUpdate);
  byId<HTMLDetailsElement>("details-2d").addEventListener("toggle", requestPlotUpdate);
  window.addEventListener("resize", requestPlotUpdate);
  document.addEventListener("keydown", handleDocumentKeyDown);
}

function updateAudioParameters(): void {
  (["volume", "frequency", "lfo", "position"] as const).forEach((name) => {
    updateAudioParameterFromInput(byId<HTMLInputElement>(`audio-${name}`));
  });
  audio.updateLfoMode(byId<HTMLSelectElement>("audio-lfo-mode").value === "pingpong" ? "pingpong" : "wrap");
}

function updateAudioParameterFromInput(input: HTMLInputElement): void {
  const name = input.id.replace(/^audio-/, "") as "volume" | "frequency" | "position" | "lfo";
  const value = readAudioControlValue(input);
  if (Number(input.value) !== value) {
    input.value = String(value);
  }
  audio.updateParameter(name, value);
}

function readAudioControlValue(input: HTMLInputElement): number {
  const value = Number(input.value);
  if (input.id === "audio-lfo" && Math.round(value) === 0) {
    return 0;
  }
  return value;
}

function installKnobDragHandlers(): void {
  document.querySelectorAll<HTMLElement>(".knob-shell").forEach((shell) => {
    shell.addEventListener("pointerdown", handleKnobPointerDown);
    shell.addEventListener("pointermove", handleKnobPointerMove);
    shell.addEventListener("pointerup", finishKnobPointerDrag);
    shell.addEventListener("pointercancel", finishKnobPointerDrag);
  });
}

function handleKnobPointerDown(event: PointerEvent): void {
  const shell = event.currentTarget;
  if (!(shell instanceof HTMLElement)) {
    return;
  }

  const input = shell.querySelector<HTMLInputElement>(".knob-input");
  if (!input) {
    return;
  }

  event.preventDefault();
  input.focus();
  activeKnobDrag = {
    input,
    pointerId: event.pointerId,
    startY: event.clientY,
    startValue: Number(input.value),
    shell,
  };
  if (input.id === "audio-position" && isAudioPlaying()) {
    audio.setPositionHold(true);
    currentPlayingCycle = Number(input.value);
    updatePositionGhost(currentPlayingCycle);
    requestPlotUpdate();
  }
  shell.classList.add("knob-dragging");
  shell.setPointerCapture(event.pointerId);
}

function handleKnobPointerMove(event: PointerEvent): void {
  if (!activeKnobDrag || activeKnobDrag.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  updateKnobFromVerticalDrag(event);
}

function finishKnobPointerDrag(event: PointerEvent): void {
  if (!activeKnobDrag || activeKnobDrag.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  const shell = activeKnobDrag.shell;
  const wasPositionDrag = activeKnobDrag.input.id === "audio-position";
  if (shell.hasPointerCapture(event.pointerId)) {
    shell.releasePointerCapture(event.pointerId);
  }
  shell.classList.remove("knob-dragging");
  activeKnobDrag = null;
  if (wasPositionDrag) {
    audio.setPositionHold(false);
  }
  commitUserStateChange();
}

function updateKnobFromVerticalDrag(event: PointerEvent): void {
  if (!activeKnobDrag) {
    return;
  }

  const { input, startValue, startY } = activeKnobDrag;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const range = max - min;
  const sensitivity = range / (event.shiftKey ? 900 : 180);
  const nextValue = Math.min(Math.max(startValue + (startY - event.clientY) * sensitivity, min), max);
  setInputValueFromNumber(input, nextValue);
  updateAudioParameterFromInput(input);
  updateKnobVisual(input);
  if (input.id === "audio-position") {
    if (isAudioPlaying()) {
      currentPlayingCycle = Number(input.value);
      updatePositionGhost(currentPlayingCycle);
    }
    requestPlotUpdate();
  }
  schedulePersistState();
}

function setInputValueFromNumber(input: HTMLInputElement, value: number): void {
  const step = input.step && input.step !== "any" ? Number(input.step) : 0;
  const nextValue = step > 0 ? Math.round(value / step) * step : value;
  input.value = String(input.id === "audio-lfo" && Math.round(nextValue) === 0 ? 0 : nextValue);
}

function updateAllKnobs(): void {
  document.querySelectorAll<HTMLInputElement>(".knob-input").forEach(updateKnobVisual);
}

function updateKnobVisual(input: HTMLInputElement): void {
  const field = input.closest<HTMLElement>(".knob-field");
  if (!field) {
    return;
  }

  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const range = max - min;
  const percent = range === 0 ? 0 : Math.min(Math.max((value - min) / range, 0), 1);
  field.style.setProperty("--knob-angle", `${-135 + percent * 270}deg`);

  const output = field.querySelector<HTMLOutputElement>("output");
  if (output) {
    output.value = formatKnobOutput(input.id, value);
  }
}

function updatePositionGhost(cycle: number): void {
  const position = document.getElementById("audio-position") as HTMLInputElement | null;
  const field = position?.closest<HTMLElement>(".knob-field");
  if (!position || !field) {
    return;
  }

  const min = Number(position.min || 0);
  const max = Number(position.max || 0);
  const range = max - min;
  const percent = range === 0 ? 0 : Math.min(Math.max((cycle - min) / range, 0), 1);
  field.style.setProperty("--knob-ghost-angle", `${-135 + percent * 270}deg`);
  field.classList.add("knob-ghost-active");
}

function clearPositionGhost(): void {
  const position = document.getElementById("audio-position") as HTMLInputElement | null;
  const field = position?.closest<HTMLElement>(".knob-field");
  field?.classList.remove("knob-ghost-active");
}

function formatKnobOutput(id: string, value: number): string {
  if (id === "audio-volume") {
    return `${Math.round(value)} dB`;
  }

  if (id === "audio-frequency") {
    const hz = Math.pow(2, value);
    return `${Math.round(hz)} Hz (${nearestNoteName(hz)})`;
  }

  if (id === "audio-lfo") {
    return `${Math.round(value)}%`;
  }

  return `${Math.round(value)}`;
}

function nearestNoteName(frequencyHz: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    return "C";
  }

  const midiNote = Math.round(12 * Math.log2(frequencyHz / 440) + 69);
  const noteIndex = ((midiNote % 12) + 12) % 12;
  return names[noteIndex] ?? "C";
}

async function toggleAudioPreview(): Promise<void> {
  if (previewRunning) {
    previewRunning = false;
    updateAudioPreviewButton();
    clearPositionGhost();
    currentPlayingCycle = null;
    await syncPreviewTransport();
    return;
  }

  previewRunning = true;
  updateAudioPreviewButton();
  await startPreviewTransport({ retrigger: true });
}

async function startPreviewTransport(options: { retrigger: boolean }): Promise<void> {
  await audio.resume();
  updateAudioParameters();
  if (options.retrigger) {
    triggerPreviewFromCurrentPosition();
  }
  audio.setTransportRunning(true);
}

async function syncPreviewTransport(): Promise<void> {
  if (previewRunning || heldMidiNotes.length > 0) {
    await startPreviewTransport({ retrigger: false });
    return;
  }

  audio.setTransportRunning(false);
  clearPositionGhost();
  currentPlayingCycle = null;
  await audio.suspend();
}

function triggerPreviewFromCurrentPosition(): void {
  const position = Number(byId<HTMLInputElement>("audio-position").value);
  audio.triggerFromPosition(position);
}

function updateAudioPreviewButton(): void {
  const button = byId<HTMLButtonElement>("audio-preview-toggle");
  button.setAttribute("aria-pressed", String(previewRunning));
  button.classList.toggle("transport-stop", previewRunning);
  button.setAttribute("aria-label", previewRunning ? "Stop preview" : "Play preview");
  button.title = previewRunning ? "Stop preview" : "Play preview";
}

async function setMidiEnabled(enabled: boolean): Promise<void> {
  const checkbox = byId<HTMLInputElement>("midi-enabled");
  checkbox.checked = enabled;

  if (!enabled) {
    disconnectMidiInputs();
    setMidiStatus("MIDI off");
    schedulePersistState();
    return;
  }

  const requestMIDIAccess =
    "requestMIDIAccess" in navigator ? navigator.requestMIDIAccess.bind(navigator) : null;
  if (!requestMIDIAccess) {
    checkbox.checked = false;
    setMidiStatus("Web MIDI is not available in this browser");
    schedulePersistState();
    return;
  }

  try {
    setMidiStatus("Connecting MIDI...");
    midiAccess = await requestMIDIAccess();
    midiAccess.onstatechange = () => {
      populateMidiInputs();
      connectSelectedMidiInput();
    };
    populateMidiInputs();
    connectSelectedMidiInput();
    setMidiStatus(selectedMidiInput ? `Listening to ${selectedMidiInput.name ?? "MIDI input"}` : "No MIDI input found");
  } catch (error) {
    console.warn("Unable to connect MIDI.", error);
    checkbox.checked = false;
    setMidiStatus("MIDI permission was not granted");
  }

  schedulePersistState();
}

function populateMidiInputs(): void {
  const select = byId<HTMLSelectElement>("midi-input");
  const previousValue = select.value || preferredMidiInputId;
  select.innerHTML = "";

  const inputs = midiAccess ? Array.from(midiAccess.inputs.values()) : [];
  if (inputs.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No MIDI input";
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  for (const input of inputs) {
    const option = document.createElement("option");
    option.value = input.id;
    option.textContent = input.name ?? input.manufacturer ?? "MIDI input";
    select.appendChild(option);
  }

  select.disabled = false;
  select.value = inputs.some((input) => input.id === previousValue) ? previousValue : (inputs[0]?.id ?? "");
  preferredMidiInputId = select.value;
}

function disconnectMidiInputs(): void {
  if (midiAccess) {
    for (const input of midiAccess.inputs.values()) {
      input.onmidimessage = null;
    }
  }

  selectedMidiInput = null;
  heldMidiNotes = [];
  byId<HTMLSelectElement>("midi-input").disabled = true;
}

function connectSelectedMidiInput(): void {
  disconnectMidiInputs();
  if (!midiAccess) {
    return;
  }

  const select = byId<HTMLSelectElement>("midi-input");
  selectedMidiInput = midiAccess.inputs.get(select.value) ?? null;
  if (selectedMidiInput) {
    selectedMidiInput.onmidimessage = handleMidiMessage;
    select.disabled = false;
    preferredMidiInputId = selectedMidiInput.id;
  }
}

function setMidiStatus(message: string): void {
  byId("midi-status").textContent = message;
}

function handleMidiMessage(event: MIDIMessageEvent): void {
  if (!event.data) {
    return;
  }

  const [statusByte = 0, note = 0, velocity = 0] = Array.from(event.data);
  const command = statusByte & 0xf0;

  if (command === 0x90 && velocity > 0) {
    heldMidiNotes = heldMidiNotes.filter((held) => held !== note);
    heldMidiNotes.push(note);
    void playMidiNote(note);
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    heldMidiNotes = heldMidiNotes.filter((held) => held !== note);
    const nextNote = heldMidiNotes.at(-1);
    if (typeof nextNote === "number") {
      void playMidiNote(nextNote);
    } else {
      void syncPreviewTransport();
    }
  }
}

async function playMidiNote(note: number): Promise<void> {
  setFrequencyFromMidiNote(note);
  await startPreviewTransport({ retrigger: false });
  triggerPreviewFromCurrentPosition();
}

function setFrequencyFromMidiNote(note: number): void {
  const hz = 440 * Math.pow(2, (note - 69) / 12);
  const frequency = byId<HTMLInputElement>("audio-frequency");
  frequency.value = String(Math.log2(hz));
  updateKnobVisual(frequency);
  updateAudioParameterFromInput(frequency);
  schedulePersistState();
}

function handleDocumentKeyDown(event: KeyboardEvent): void {
  if (isFileExportNameTarget(event.target)) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
    event.preventDefault();
    if (event.shiftKey) {
      redoState();
    } else {
      undoState();
    }
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.code === "KeyY") {
    event.preventDefault();
    redoState();
    return;
  }

  if (handleWorkflowShortcut(event)) {
    return;
  }

  handleKeyboardPreview(event);
}

function handleWorkflowShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || isFileExportNameTarget(event.target)) {
    return false;
  }

  switch (event.key.toLowerCase()) {
    case "j":
      event.preventDefault();
      selectGeneratorByOffset(1);
      return true;
    case "k":
      event.preventDefault();
      selectGeneratorByOffset(-1);
      return true;
    case "n":
      event.preventDefault();
      selectFieldByOffset(1);
      return true;
    case "p":
      event.preventDefault();
      selectFieldByOffset(-1);
      return true;
    case "e":
      event.preventDefault();
      focusSelectedField();
      return true;
    case "u":
      event.preventDefault();
      moveSelectedGenerator(-1);
      return true;
    case "d":
      event.preventDefault();
      moveSelectedGenerator(1);
      return true;
    case "m":
      event.preventDefault();
      toggleSelectedGeneratorEnabled();
      return true;
    case "a":
      event.preventDefault();
      randomizeAllActiveGenerators();
      return true;
    case "g":
      event.preventDefault();
      randomizeSelectedGenerator();
      return true;
    case "r":
      event.preventDefault();
      randomizeSelectedRow();
      return true;
    case "v":
      event.preventDefault();
      randomizeSelectedField();
      return true;
    case "?":
      event.preventDefault();
      byId<HTMLDialogElement>("help-dialog").showModal();
      return true;
    case "i":
      event.preventDefault();
      byId<HTMLDialogElement>("info-dialog").showModal();
      return true;
    default:
      return false;
  }
}

function isFileExportNameTarget(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLElement && target.id === "file-name") ||
    (document.activeElement instanceof HTMLElement && document.activeElement.id === "file-name")
  );
}

function handleKeyboardPreview(event: KeyboardEvent): void {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return;
  }

  const keyMap: Record<string, number> = {
    KeyA: 0,
    KeyW: 1,
    KeyS: 2,
    KeyE: 3,
    KeyD: 4,
    KeyF: 5,
    KeyT: 6,
    KeyG: 7,
    KeyY: 8,
    KeyH: 9,
    KeyU: 10,
    KeyJ: 11,
    KeyK: 12,
  };
  const semitone = keyMap[event.code];
  if (typeof semitone !== "number") {
    return;
  }

  const note = 5 * 12 + semitone;
  const hz = 440 * Math.pow(2, (note - 69) / 12);
  const frequency = byId<HTMLInputElement>("audio-frequency");
  frequency.value = String(Math.log2(hz));
  updateKnobVisual(frequency);
  updateAudioParameterFromInput(frequency);
  schedulePersistState();
}

setupShell();
applyTheme(DEFAULT_THEME_ID);
appendGeneratorOptions();
const startupParams = new URLSearchParams(window.location.search);
const sharedState = loadSharedState(startupParams);
const persistedState = sharedState ? null : loadPersistedState();
const startupPatch = sharedState || persistedState ? null : getStartupPatch();
appendInitialUnits(startupPatch);
byId<HTMLSelectElement>("theme-select").value = DEFAULT_THEME_ID;
if (sharedState) {
  applyAppState(sharedState);
  clearSharedStateParam();
} else if (persistedState) {
  applyAppState(persistedState);
} else {
  updateAllKnobs();
}
initDropEvents();
installEventHandlers();
initializeStateTracking();
if (byId<HTMLInputElement>("midi-enabled").checked) {
  void setMidiEnabled(true);
}
void generate();
requestAnimationFrame(plotLoop);
