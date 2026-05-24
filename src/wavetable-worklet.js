function dbtoa(db) {
  return Math.pow(10, db / 20);
}

function clipRange(input, low, high) {
  return Math.max(Math.min(input, high), low);
}

function lerp(pos, a, b) {
  return (1 - pos) * a + pos * b;
}

const DEFAULT_FREQUENCY_LOG2 = Math.log2(42);

class WaveTableProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.waveTables = [];
    this.previousWaveTables = [];
    this.tableSize = 0;
    this.numCycles = 0;
    this.phase = 0;
    this.phaseInc = 0;
    this.cycle = 0;
    this.cycleMod = 0;
    this.lfoDirection = 1;
    this.lfoMode = "pingpong";
    this.prevPosition = 0;
    this.frameCount = 0;
    this.lastPositionSent = -1;
    this.framesSincePositionUpdate = 0;
    this.ignorePositionFrames = 0;
    this.positionHold = false;
    this.transportRunning = false;
    this.cycleModTimeout = 100;
    this.tableFadeSamples = Math.max(1, Math.floor(sampleRate * 0.025));
    this.tableFadeRemaining = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === "tables") {
        const hadTables = this.waveTables.length > 0;
        this.previousWaveTables = this.waveTables;
        this.waveTables = event.data.buffers;
        this.tableSize = event.data.tableSize;
        this.numCycles = event.data.numCycles;
        this.cycle = clipRange(this.cycle, 0, Math.max(0, this.numCycles - 1));
        this.tableFadeRemaining = hadTables ? this.tableFadeSamples : 0;
      } else if (event.data.type === "lfoMode") {
        this.lfoMode = event.data.mode;
      } else if (event.data.type === "transport") {
        this.transportRunning = event.data.running;
      } else if (event.data.type === "trigger") {
        this.triggerFromPosition(event.data.position);
      } else if (event.data.type === "positionHold") {
        this.positionHold = Boolean(event.data.holding);
        this.framesSincePositionUpdate = this.positionHold ? 0 : this.cycleModTimeout + 1;
        this.ignorePositionFrames = this.positionHold ? this.ignorePositionFrames : 0;
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: "volume", defaultValue: -12, minValue: -96, maxValue: 0 },
      { name: "frequency", defaultValue: DEFAULT_FREQUENCY_LOG2 },
      { name: "position", defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: "lfo", defaultValue: 0 },
    ];
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    const firstChannel = output?.[0];
    if (!output || !firstChannel) {
      return true;
    }

    const bufSize = firstChannel.length;
    const frequencyValues = parameters.frequency ?? new Float32Array([DEFAULT_FREQUENCY_LOG2]);
    const volumeValues = parameters.volume ?? new Float32Array([-96]);

    const position = parameters.position?.[0] ?? 0;
    if (this.positionHold) {
      this.cycleMod = this.numCycles > 0 ? position / this.numCycles : 0;
      this.prevPosition = position;
      this.framesSincePositionUpdate = 0;
      this.syncCycleToMod();
    } else if (this.ignorePositionFrames > 0) {
      this.prevPosition = position;
      this.ignorePositionFrames -= 1;
    } else if (Math.abs(this.prevPosition - position) > 0.0001) {
      this.cycleMod = this.numCycles > 0 ? position / this.numCycles : 0;
      this.prevPosition = position;
      this.lfoDirection = 1;
      this.framesSincePositionUpdate = 0;
    }

    if (this.transportRunning && this.framesSincePositionUpdate > this.cycleModTimeout) {
      const rawLfo = parameters.lfo?.[0] ?? 0;
      let lfo = (Math.round(rawLfo) === 0 ? 0 : rawLfo) / 100;
      lfo *= lfo * lfo;
      if (this.lfoMode === "pingpong") {
        this.cycleMod += (lfo / 25) * this.lfoDirection;
        this.reflectCycleMod();
      } else {
        this.cycleMod += lfo / 25;
        this.wrapCycleMod();
      }
    }

    const currentTable = this.waveTables[this.cycle];
    if (this.waveTables.length > 0 && currentTable && this.tableSize > 0) {
      for (let sampleIndex = 0; sampleIndex < bufSize; sampleIndex += 1) {
        const frequency = frequencyValues[sampleIndex] ?? frequencyValues[0] ?? DEFAULT_FREQUENCY_LOG2;
        this.phaseInc = Math.pow(2, frequency) / sampleRate;

        let sample = this.sampleTables(this.waveTables, this.cycle);
        if (this.tableFadeRemaining > 0 && this.previousWaveTables.length > 0) {
          const fade = 1 - this.tableFadeRemaining / this.tableFadeSamples;
          const previousCycle = clipRange(this.cycle, 0, this.previousWaveTables.length - 1);
          sample = lerp(fade, this.sampleTables(this.previousWaveTables, previousCycle), sample);
          this.tableFadeRemaining -= 1;
          if (this.tableFadeRemaining <= 0) {
            this.previousWaveTables = [];
          }
        }

        const volume = volumeValues[sampleIndex] ?? volumeValues[0] ?? -96;
        sample *= volume <= -96 ? 0 : dbtoa(volume);

        this.phase += this.phaseInc;
        if (this.phase >= 1) {
          this.phase -= 1;
          this.syncCycleToMod();
        }

        if (!Number.isFinite(sample)) {
          sample = 0;
        }

        for (const channel of output) {
          channel[sampleIndex] = sample;
        }
      }
    }

    if (
      this.frameCount % 16 === 0 &&
      this.framesSincePositionUpdate > this.cycleModTimeout &&
      this.cycle !== this.lastPositionSent
    ) {
      this.port.postMessage({ cycle: this.cycle });
      this.lastPositionSent = this.cycle;
    }

    this.frameCount += 1;
    this.framesSincePositionUpdate += 1;
    return true;
  }

  triggerFromPosition(position) {
    this.phase = 0;
    this.cycleMod = this.numCycles > 0 ? position / this.numCycles : 0;
    this.syncCycleToMod();
    this.prevPosition = position;
    this.lfoDirection = 1;
    this.framesSincePositionUpdate = this.cycleModTimeout + 1;
    this.ignorePositionFrames = 16;
    this.lastPositionSent = -1;
  }

  sampleTables(tables, cycle) {
    const table = tables[cycle];
    const size = table?.length ?? 0;
    if (!table || size === 0) {
      return 0;
    }

    const idx = Math.floor(this.phase * size);
    const pos = this.phase * size - idx;
    return lerp(pos, table[idx] ?? 0, table[(idx + 1) % size] ?? 0);
  }

  syncCycleToMod() {
    this.cycle = clipRange(Math.floor(this.cycleMod * this.numCycles), 0, Math.max(0, this.numCycles - 1));
  }

  wrapCycleMod() {
    if (this.cycleMod > 1) {
      this.cycleMod = 0;
    } else if (this.cycleMod < 0) {
      this.cycleMod = 1;
    }
  }

  reflectCycleMod() {
    while (this.cycleMod > 1 || this.cycleMod < 0) {
      if (this.cycleMod > 1) {
        this.cycleMod = 2 - this.cycleMod;
      } else {
        this.cycleMod = -this.cycleMod;
      }
      this.lfoDirection *= -1;
    }
  }
}

registerProcessor("wavetable-processor", WaveTableProcessor);
