#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <string>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

using emscripten::function;
using emscripten::typed_memory_view;
using emscripten::val;

namespace {

constexpr float kPi = 3.14159265358979323846f;

struct Settings {
  int tableSize = 2048;
  int numCycles = 128;
  int normalize = 0;
  bool fixNonZero = false;
  bool removeDuplicates = false;
};

std::vector<float> gTables;
std::vector<uint8_t> gRenderBuffer;
int gTableSize = 2048;
int gNumCycles = 128;
int gDefaultFormat = 2;
int gDefaultEncoding = 1;

float clamp(float input, float low, float high) {
  return std::max(low, std::min(high, input));
}

float clampSteppedRamp(float input, float previous, float current) {
  float high = current > previous ? current : previous;
  float low = current < previous ? current : previous;
  float lowClamped = input < low ? low : input;
  return high < lowClamped ? high : lowClamped;
}

float lerp(float position, float a, float b) {
  return a + position * (b - a);
}

float dbToAmp(float db) {
  return std::pow(10.0f, db / 20.0f);
}

float sinTurn(float ratio, float phase) {
  return std::sin(ratio * ((phase + phase) * kPi));
}

float sinHalfTurn(float phase) {
  return std::sin(phase * kPi);
}

bool missing(const val& value) {
  return value.isUndefined() || value.isNull();
}

float readFloat(const val& object, const char* key, float fallback = 0.0f) {
  val value = object[key];
  return missing(value) ? fallback : value.as<float>();
}

int readInt(const val& object, const char* key, int fallback = 0) {
  val value = object[key];
  return missing(value) ? fallback : value.as<int>();
}

bool readBool(const val& object, const char* key, bool fallback = false) {
  val value = object[key];
  return missing(value) ? fallback : value.as<bool>();
}

Settings readSettings(const val& root) {
  Settings settings;
  val source = root["settings"];
  if (missing(source)) {
    return settings;
  }

  settings.tableSize = std::max(1, readInt(source, "tableSize", settings.tableSize));
  settings.numCycles = std::max(1, readInt(source, "numCycles", settings.numCycles));
  settings.normalize = readInt(source, "normalize", settings.normalize);
  settings.fixNonZero = readBool(source, "fixNonZero", settings.fixNonZero);
  settings.removeDuplicates = readBool(source, "removeDuplicates", settings.removeDuplicates);
  return settings;
}

float shapedPosition(float position, float curve) {
  if (std::fabs(curve) < 0.000001f) {
    return position;
  }
  return std::pow(position, std::exp2(-curve));
}

float parameterValue(const val& unit, const char* name, int cycle, int cycles) {
  val parameter = unit[name];
  if (missing(parameter)) {
    return 0.0f;
  }

  float start = readFloat(parameter, "start");
  float end = readFloat(parameter, "end", start);
  float curve = readFloat(parameter, "curve");
  bool round = readBool(parameter, "round");
  float t = cycles <= 1 ? 0.0f : static_cast<float>(cycle) / static_cast<float>(cycles - 1);
  float value = lerp(shapedPosition(t, curve), start, end);
  return round ? std::round(value) : value;
}

uint64_t nextNoiseState(uint64_t state, float& value) {
  uint64_t next = state * 196314165ULL + 907633515ULL;
  value = static_cast<float>(next >> 32U) * std::pow(2.0f, -31.0f) - 1.0f;
  return next;
}

std::vector<float> steppedRamp(
    int tableSize,
    float rate,
    float rampPercent,
    const std::function<float(int sample, float segmentLength)>& nextValue) {
  std::vector<float> table(static_cast<size_t>(tableSize));
  int roundedRate = std::max(1, static_cast<int>(std::round(rate)));
  float segmentLength = static_cast<float>(tableSize) / static_cast<float>(roundedRate);
  float ramp = std::max(rampPercent / 100.0f, 0.0001f);
  float rampSamples = segmentLength * ramp;
  float inverseSegmentLength = 1.0f / segmentLength;
  float holdHalfLength = segmentLength * (1.0f - ramp) * 0.5f;
  float current = 0.0f;
  float previous = 0.0f;
  float rampValue = 0.0f;
  float slope = 0.0f;
  float segmentPhase = 1.0f;

  for (int sample = 0; sample < tableSize; ++sample) {
    if (segmentPhase >= 1.0f) {
      float next = 0.0f;
      segmentPhase -= 1.0f;

      if (inverseSegmentLength * static_cast<float>(tableSize - sample) > 1.0f) {
        next = nextValue(sample, segmentLength);
      }

      slope = (next - current) / rampSamples;
      rampValue = current - holdHalfLength * slope;
      previous = current;
      current = next;
    }

    table[static_cast<size_t>(sample)] = clampSteppedRamp(rampValue, previous, current);
    rampValue += slope;
    segmentPhase += inverseSegmentLength;
  }

  return table;
}

void addSinewaveFm(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  float modRatio = parameterValue(unit, "modulator ratio", cycle, cycles);
  float modVolume = dbToAmp(parameterValue(unit, "modulator volume", cycle, cycles));
  float carrierRatio = parameterValue(unit, "carrier ratio", cycle, cycles);
  float carrierVolume = dbToAmp(parameterValue(unit, "carrier volume", cycle, cycles));
  int tableSize = static_cast<int>(table.size());

  for (int sample = 0; sample < tableSize; ++sample) {
    float phase = static_cast<float>(sample) / static_cast<float>(tableSize);
    float modulator = sinTurn(modRatio, phase);
    float carrierPhase = carrierRatio * phase + sinHalfTurn(phase) * (modVolume * modulator);
    table[static_cast<size_t>(sample)] += sinTurn(1.0f, carrierPhase) * carrierVolume;
  }
}

void addResonantSine(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  float ratio = parameterValue(unit, "overtone ratio", cycle, cycles);
  float shape = std::exp2(parameterValue(unit, "overtone shape", cycle, cycles) / 25.0f);
  float volume = dbToAmp(parameterValue(unit, "volume", cycle, cycles));
  int tableSize = static_cast<int>(table.size());
  float previousPeak = 0.0f;
  float divisor = 1.0f;

  for (int sample = static_cast<int>(std::ceil((0.25f / ratio) * tableSize)); sample >= 0; --sample) {
    float phase = static_cast<float>(sample) / static_cast<float>(tableSize);
    float candidate = sinTurn(ratio, phase) * std::pow(1.0f - phase, shape);
    divisor = candidate;
    if (candidate < previousPeak) {
      break;
    }
    previousPeak = candidate;
  }

  float gain = divisor == 0.0f ? 0.0f : volume * (1.0f / divisor);
  for (int sample = 0; sample < tableSize; ++sample) {
    float phase = static_cast<float>(sample) / static_cast<float>(tableSize);
    table[static_cast<size_t>(sample)] += (gain * sinTurn(ratio, phase)) * std::pow(1.0f - phase, shape);
  }
}

void addMergedSine(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  float ratioA = parameterValue(unit, "ratio A", cycle, cycles);
  float ratioB = parameterValue(unit, "ratio B", cycle, cycles);
  float volume = dbToAmp(parameterValue(unit, "volume", cycle, cycles));
  int tableSize = static_cast<int>(table.size());

  for (int sample = 0; sample < tableSize; ++sample) {
    float phase = static_cast<float>(sample) / static_cast<float>(tableSize);
    float a = sinTurn(ratioA, phase);
    float b = sinTurn(ratioB, phase);
    table[static_cast<size_t>(sample)] += std::max(a, b) * volume;
  }
}

void addNoise(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  int tableSize = static_cast<int>(table.size());
  float seed = parameterValue(unit, "seed", cycle, cycles);
  float rate = parameterValue(unit, "rate", cycle, cycles);
  float ramp = parameterValue(unit, "ramp", cycle, cycles);
  float volume = dbToAmp(parameterValue(unit, "volume", cycle, cycles));
  uint64_t state = static_cast<uint64_t>(static_cast<int64_t>(std::round(seed)) + 22222LL);

  std::vector<float> noise = steppedRamp(tableSize, rate, ramp, [&](int, float) {
    float value = 0.0f;
    state = nextNoiseState(state, value);
    return value;
  });

  for (int sample = 0; sample < tableSize; ++sample) {
    table[static_cast<size_t>(sample)] += noise[static_cast<size_t>(sample)] * volume;
  }
}

void applyHardClip(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  float gain = dbToAmp(parameterValue(unit, "gain", cycle, cycles));
  float bias = clamp(parameterValue(unit, "bias", cycle, cycles) / 100.0f, -1.0f, 1.0f);
  for (float& sample : table) {
    sample = clamp(sample * gain + bias, -1.0f, 1.0f) - bias;
  }
}

void applySoftClip(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  float gain = dbToAmp(parameterValue(unit, "gain", cycle, cycles));
  float bias = parameterValue(unit, "bias", cycle, cycles) / 100.0f;
  float gainScale = 1.0f / std::tanh(gain);
  float biasOffset = -std::tanh(bias);
  for (float& sample : table) {
    sample = std::tanh(sample * gain + bias) * gainScale + biasOffset;
  }
}

void applyBitCrush(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  int bits = std::max(1, std::min(32, static_cast<int>(std::round(parameterValue(unit, "bits", cycle, cycles)))));
  if (bits >= 32) {
    return;
  }
  float levels = static_cast<float>(1U << bits);
  for (float& sample : table) {
    sample = std::round(clamp(sample, -1.0f, 1.0f) * levels) / levels;
  }
}

void applyDownsample(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  int tableSize = static_cast<int>(table.size());
  float rate = std::max(2.0f, std::round(parameterValue(unit, "rate", cycle, cycles)));
  float ramp = clamp(parameterValue(unit, "ramp", cycle, cycles) / 100.0f, 0.0f, 1.0f);
  std::vector<float> copy = table;
  table = steppedRamp(tableSize, rate, ramp * 100.0f, [&](int sample, float segmentLength) {
    int nextIndex = static_cast<int>(segmentLength + static_cast<float>(sample));
    return nextIndex >= 0 && nextIndex < tableSize ? copy[static_cast<size_t>(nextIndex)] : 0.0f;
  });
}

void applyRingMod(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  float ratio = parameterValue(unit, "ratio", cycle, cycles);
  float carrierGain = dbToAmp(parameterValue(unit, "carrier gain", cycle, cycles));
  float gainScale = 1.0f / std::tanh(carrierGain);
  int tableSize = static_cast<int>(table.size());
  for (int sample = 0; sample < tableSize; ++sample) {
    float phase = static_cast<float>(sample) / static_cast<float>(tableSize);
    float carrier = gainScale * std::tanh(carrierGain * std::sin(ratio * (phase * kPi)));
    table[static_cast<size_t>(sample)] *= carrier;
  }
}

void removeEndpoints(std::vector<float>& table) {
  if (table.size() < 2) {
    return;
  }
  float start = std::fabs(table.front()) < 0.01f ? 0.0f : table.front();
  float end = std::fabs(table.back()) < 0.01f ? 0.0f : table.back();
  if (start == 0.0f && end == 0.0f) {
    return;
  }
  float length = static_cast<float>(table.size());
  for (size_t i = 0; i < table.size(); ++i) {
    table[i] -= lerp(static_cast<float>(i) / length, start, end);
  }
}

void normalizeTotal(std::vector<std::vector<float>>& tables) {
  float peak = 0.0f;
  for (const auto& table : tables) {
    for (float sample : table) {
      peak = std::max(peak, std::fabs(sample));
    }
  }
  if (peak <= 0.0f) {
    return;
  }
  float gain = 1.0f / peak;
  for (auto& table : tables) {
    for (float& sample : table) {
      sample *= gain;
    }
  }
}

void normalizeCycle(std::vector<float>& table, bool stretch) {
  float minValue = std::numeric_limits<float>::infinity();
  float maxValue = -std::numeric_limits<float>::infinity();
  float peak = 0.0f;

  for (float sample : table) {
    minValue = std::min(minValue, sample);
    maxValue = std::max(maxValue, sample);
    peak = std::max(peak, std::fabs(sample));
  }

  if (stretch) {
    float mid = (maxValue + minValue) * 0.5f;
    float halfRange = (maxValue - minValue) * 0.5f;
    if (halfRange > 0.0f) {
      for (float& sample : table) {
        sample = (sample - mid) / halfRange;
      }
    }
    return;
  }

  if (peak > 0.0f) {
    float gain = 1.0f / peak;
    for (float& sample : table) {
      sample *= gain;
    }
  }
}

float tableMean(const std::vector<float>& table) {
  float sum = 0.0f;
  for (float sample : table) {
    sum += sample;
  }
  return table.empty() ? 0.0f : sum / static_cast<float>(table.size());
}

bool sameTable(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (std::fabs(a[i] - b[i]) > 0.000001f) {
      return false;
    }
  }
  return true;
}

std::vector<std::vector<float>> removeDuplicates(const std::vector<std::vector<float>>& tables) {
  std::vector<std::vector<float>> deduped;
  for (const auto& table : tables) {
    if (deduped.empty() || !sameTable(deduped.back(), table)) {
      deduped.push_back(table);
    }
  }
  if (deduped.empty() && !tables.empty()) {
    deduped.push_back(tables.front());
  }
  return deduped;
}

void renderUnit(std::vector<float>& table, const val& unit, int cycle, int cycles) {
  std::string name = unit["generator"].as<std::string>();

  if (name == "sinewave FM") {
    addSinewaveFm(table, unit, cycle, cycles);
  } else if (name == "resonant sine") {
    addResonantSine(table, unit, cycle, cycles);
  } else if (name == "merged sine") {
    addMergedSine(table, unit, cycle, cycles);
  } else if (name == "noise") {
    addNoise(table, unit, cycle, cycles);
  } else if (name == "hard clip") {
    applyHardClip(table, unit, cycle, cycles);
  } else if (name == "soft clip") {
    applySoftClip(table, unit, cycle, cycles);
  } else if (name == "bit crush") {
    applyBitCrush(table, unit, cycle, cycles);
  } else if (name == "downsample") {
    applyDownsample(table, unit, cycle, cycles);
  } else if (name == "ring mod") {
    applyRingMod(table, unit, cycle, cycles);
  }
}

void appendAscii(std::vector<uint8_t>& out, const char* text) {
  while (*text) {
    out.push_back(static_cast<uint8_t>(*text++));
  }
}

void writeU16(std::vector<uint8_t>& out, uint16_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xffU));
  out.push_back(static_cast<uint8_t>((value >> 8U) & 0xffU));
}

void writeU32(std::vector<uint8_t>& out, uint32_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xffU));
  out.push_back(static_cast<uint8_t>((value >> 8U) & 0xffU));
  out.push_back(static_cast<uint8_t>((value >> 16U) & 0xffU));
  out.push_back(static_cast<uint8_t>((value >> 24U) & 0xffU));
}

std::vector<uint8_t> encodeSamples(int bytesPerSample) {
  std::vector<uint8_t> out;
  out.reserve(gTables.size() * static_cast<size_t>(bytesPerSample));

  for (float raw : gTables) {
    float sample = clamp(std::isfinite(raw) ? raw : 0.0f, -1.0f, 1.0f);
    if (bytesPerSample == 1) {
      out.push_back(static_cast<uint8_t>(std::round((sample + 1.0f) * 127.5f)));
    } else if (bytesPerSample == 2) {
      int16_t value = static_cast<int16_t>(std::max(-32768.0f, std::min(32767.0f, std::round(sample * 32767.0f))));
      writeU16(out, static_cast<uint16_t>(value));
    } else {
      uint32_t value = 0;
      static_assert(sizeof(float) == sizeof(uint32_t), "float must be 32-bit");
      std::memcpy(&value, &sample, sizeof(float));
      writeU32(out, value);
    }
  }

  return out;
}

void appendChunk(std::vector<uint8_t>& out, const char* id, const std::vector<uint8_t>& payload) {
  appendAscii(out, id);
  writeU32(out, static_cast<uint32_t>(payload.size()));
  out.insert(out.end(), payload.begin(), payload.end());
  if ((payload.size() & 1U) != 0U) {
    out.push_back(0);
  }
}

void appendChunkWithSize(std::vector<uint8_t>& out, const char* id, uint32_t size, const std::vector<uint8_t>& payload) {
  appendAscii(out, id);
  writeU32(out, size);
  out.insert(out.end(), payload.begin(), payload.end());
}

std::vector<uint8_t> encodeWav(int bytesPerSample, bool addClmChunk) {
  constexpr uint32_t sampleRate = 44100;
  std::vector<uint8_t> data = encodeSamples(bytesPerSample);

  std::vector<uint8_t> fmt;
  writeU16(fmt, bytesPerSample == 4 ? 3 : 1);
  writeU16(fmt, 1);
  writeU32(fmt, sampleRate);
  writeU32(fmt, sampleRate * static_cast<uint32_t>(bytesPerSample));
  writeU16(fmt, static_cast<uint16_t>(bytesPerSample));
  writeU16(fmt, static_cast<uint16_t>(bytesPerSample * 8));

  std::vector<uint8_t> chunks;
  appendChunk(chunks, "fmt ", fmt);
  if (addClmChunk) {
    std::string clm = "<!>" + std::to_string(gTableSize);
    std::vector<uint8_t> payload(clm.begin(), clm.end());
    payload.push_back(0);
    appendChunk(chunks, "clm ", payload);
  }
  appendChunk(chunks, "data", data);

  std::vector<uint8_t> wav;
  appendAscii(wav, "RIFF");
  writeU32(wav, static_cast<uint32_t>(4 + chunks.size()));
  appendAscii(wav, "WAVE");
  wav.insert(wav.end(), chunks.begin(), chunks.end());
  return wav;
}

std::string paddedTableSize() {
  std::string value = std::to_string(gTableSize);
  while (value.size() < 4) {
    value.insert(value.begin(), '0');
  }
  return value;
}

std::vector<uint8_t> encodeFloatWav(int bytesPerSample, bool addClmChunk) {
  constexpr uint32_t sampleRate = 48000;

  std::vector<uint8_t> fmt;
  writeU16(fmt, 3);
  writeU16(fmt, 1);
  writeU32(fmt, sampleRate);
  writeU32(fmt, sampleRate * static_cast<uint32_t>(bytesPerSample));
  writeU16(fmt, static_cast<uint16_t>(bytesPerSample));
  writeU16(fmt, static_cast<uint16_t>(bytesPerSample * 8));

  std::vector<uint8_t> data;
  data.reserve(gTables.size() * sizeof(float));
  for (float sample : gTables) {
    uint32_t value = 0;
    std::memcpy(&value, &sample, sizeof(float));
    writeU32(data, value);
  }

  std::vector<uint8_t> chunks;
  appendChunkWithSize(chunks, "fmt ", static_cast<uint32_t>(fmt.size()), fmt);
  appendChunkWithSize(chunks, "data", static_cast<uint32_t>(gTables.size()), data);
  if (addClmChunk) {
    std::string clm = "<!>" + paddedTableSize() + " 00000000 wavetabl.es ";
    std::vector<uint8_t> payload(clm.begin(), clm.end());
    appendChunkWithSize(chunks, "clm ", static_cast<uint32_t>(payload.size()), payload);
  }

  std::vector<uint8_t> wav;
  appendAscii(wav, "RIFF");
  writeU32(wav, static_cast<uint32_t>(4 + chunks.size()));
  appendAscii(wav, "WAVE");
  wav.insert(wav.end(), chunks.begin(), chunks.end());
  return wav;
}

}  // namespace

void configDefaults(int format, int encoding) {
  gDefaultFormat = format;
  gDefaultEncoding = encoding;
}

val generate(const std::string& json) {
  val root = val::global("JSON").call<val>("parse", json);
  Settings settings = readSettings(root);
  val units = root["units"];
  int unitCount = missing(units) ? 0 : units["length"].as<int>();

  std::vector<std::vector<float>> tables;
  tables.reserve(static_cast<size_t>(settings.numCycles));

  for (int cycle = 0; cycle < settings.numCycles; ++cycle) {
    std::vector<float> table(static_cast<size_t>(settings.tableSize), 0.0f);
    for (int unitIndex = 0; unitIndex < unitCount; ++unitIndex) {
      renderUnit(table, units[unitIndex], cycle, settings.numCycles);
    }
    if (settings.fixNonZero) {
      removeEndpoints(table);
    }
    tables.push_back(table);
  }

  if (settings.normalize == 1) {
    normalizeTotal(tables);
  } else if (settings.normalize == 2 || settings.normalize == 3) {
    for (auto& table : tables) {
      normalizeCycle(table, settings.normalize == 3);
    }
  }

  bool containsOffset = false;
  val nonZeroCycles = val::array();
  for (auto& table : tables) {
    for (float& sample : table) {
      sample = clamp(sample, -1.0f, 1.0f);
    }
    bool nonZero = table.empty() ? false : std::fabs(table.back() - table.front()) > 0.02f;
    nonZeroCycles.call<void>("push", nonZero);
    if (nonZero) {
      containsOffset = true;
    }
  }

  if (settings.removeDuplicates) {
    tables = removeDuplicates(tables);
  }

  gTableSize = settings.tableSize;
  gNumCycles = static_cast<int>(tables.size());
  gTables.clear();
  gTables.reserve(static_cast<size_t>(gTableSize * gNumCycles));
  for (const auto& table : tables) {
    gTables.insert(gTables.end(), table.begin(), table.end());
  }

  val result = val::object();
  result.set("buffer", val(typed_memory_view(gTables.size(), gTables.data())));
  result.set("tableContainsOffset", containsOffset);
  result.set("nonZeroCycles", nonZeroCycles);
  return result;
}

val render(int bytesPerSample, int fileFormat, int addClmChunk) {
  if (bytesPerSample != 1 || fileFormat != 0) {
    return val::undefined();
  }

  gRenderBuffer = encodeFloatWav(bytesPerSample, addClmChunk != 0);
  return val(typed_memory_view(gRenderBuffer.size(), gRenderBuffer.data()));
}

EMSCRIPTEN_BINDINGS(wavetable_generator) {
  function("configDefaults", &configDefaults);
  function("generate", &generate);
  function("render", &render);
}
