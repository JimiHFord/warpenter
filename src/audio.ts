import workletUrl from "./wavetable-worklet.js?url";

export type LfoMode = "wrap" | "pingpong";
type AudioParameterName = "volume" | "frequency" | "position" | "lfo";

const DEFAULT_FREQUENCY_HZ = 42;

function dbToAmp(db: number): number {
  if (db <= -96) {
    return 0;
  }
  return Math.pow(10, db / 20);
}

export class WavetableAudio {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private fallbackSource: OscillatorNode | null = null;
  private fallbackGain: GainNode | null = null;
  private initialized = false;
  private latestTables: Float32Array[] = [];

  onCycle: (cycle: number) => void = () => {};

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.context = new AudioContext();

    try {
      await this.context.audioWorklet.addModule(workletUrl);
      this.node = new AudioWorkletNode(this.context, "wavetable-processor", {
        outputChannelCount: [2],
      });
      this.node.connect(this.context.destination);
      this.node.port.onmessage = (event: MessageEvent<{ cycle?: number }>) => {
        if (typeof event.data.cycle === "number") {
          this.onCycle(event.data.cycle);
        }
      };
      this.sendLatestTables();
    } catch (error) {
      console.warn("AudioWorklet unavailable; using oscillator fallback.", error);
      this.fallbackGain = new GainNode(this.context, { gain: 0 });
      this.fallbackSource = new OscillatorNode(this.context, { type: "sine", frequency: DEFAULT_FREQUENCY_HZ });
      this.fallbackSource.connect(this.fallbackGain).connect(this.context.destination);
      this.fallbackSource.start();
    }

    this.initialized = true;
  }

  async resume(): Promise<void> {
    await this.init();
    await this.context?.resume();
  }

  async suspend(): Promise<void> {
    await this.context?.suspend();
  }

  setTransportRunning(running: boolean): void {
    this.node?.port.postMessage({ type: "transport", running });
  }

  triggerFromPosition(position: number): void {
    this.node?.port.postMessage({ type: "trigger", position });
  }

  setPositionHold(holding: boolean): void {
    this.node?.port.postMessage({ type: "positionHold", holding });
  }

  updateTables(tables: Float32Array[]): void {
    if (tables.length === 0) {
      return;
    }

    this.latestTables = tables.map((table) => new Float32Array(table));
    this.sendLatestTables();
  }

  private sendLatestTables(): void {
    if (!this.node || this.latestTables.length === 0) {
      return;
    }

    const buffers = this.latestTables.map((table) => new Float32Array(table));
    this.node.port.postMessage({
      type: "tables",
      tableSize: this.latestTables[0]?.length ?? 0,
      numCycles: this.latestTables.length,
      buffers,
    }, buffers.map((buffer) => buffer.buffer as ArrayBuffer));
  }

  updateParameter(name: AudioParameterName, value: number): void {
    if (this.node && this.context) {
      const parameter = this.node.parameters.get(name);
      if (parameter) {
        const now = this.context.currentTime;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(value, now);
        // Temporarily disabled while tuning UI/audio responsiveness.
        // parameter.setTargetAtTime(value, now, name === "position" ? 0.02 : 0.012);
      }
    }

    if (this.context && this.fallbackGain && name === "volume") {
      this.fallbackGain.gain.setValueAtTime(dbToAmp(value), this.context.currentTime);
      // this.fallbackGain.gain.setTargetAtTime(dbToAmp(value), this.context.currentTime, 0.01);
    }

    if (this.context && this.fallbackSource && name === "frequency") {
      this.fallbackSource.frequency.setValueAtTime(Math.pow(2, value), this.context.currentTime);
      // this.fallbackSource.frequency.setTargetAtTime(Math.pow(2, value), this.context.currentTime, 0.01);
    }
  }

  updateLfoMode(mode: LfoMode): void {
    this.node?.port.postMessage({ type: "lfoMode", mode });
  }
}
