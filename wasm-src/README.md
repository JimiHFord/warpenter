# Wavetable Generator Source

This directory contains the C++/Emscripten source for the wavetable generator
used by the TypeScript UI.

The generated `public/generator.js` and `public/generator.wasm` files are
intentionally ignored by Git and are rebuilt from this source.

## Build

Install and activate the local Emscripten SDK:

```powershell
npm run install:emsdk
```

The installer defaults to Emscripten `5.0.7` so CI and local rebuilds use the
same toolchain. Set `EMSDK_VERSION` before running the installer if you need to
test another Emscripten release.

Then run one of:

```sh
./wasm-src/build.sh
```

```powershell
.\wasm-src\build.ps1
```

Both scripts emit:

- `public/generator.js`
- `public/generator.wasm`

Set `WASM_OUT_DIR` to write the rebuilt engine somewhere else:

```powershell
$env:WASM_OUT_DIR = "$PWD\.tools\wasm-rebuild"
npm run build:wasm
```

`npm run build` also runs `npm run build:wasm`, so production app builds fail if
the generated WASM cannot be rebuilt from source.

## API

The module exports:

- `configDefaults(format, encoding)`
- `generate(json)`
- `render(bytesPerSample, fileFormat, addClmChunk)`

`generate(json)` expects this shape:

```json
{
  "settings": {
    "tableSize": 2048,
    "numCycles": 128,
    "normalize": 0,
    "fixNonZero": false,
    "removeDuplicates": false
  },
  "units": [
    {
      "generator": "sinewave FM",
      "carrier ratio": { "start": 1, "end": 1, "curve": 0, "round": false }
    }
  ]
}
```

## Implementation Notes

The generator source intentionally avoids vendoring a large JSON header by using
JavaScript's `JSON.parse` through `emscripten::val`.

Important math details:

- Parameter curves use `position ** exp2(-curve)`.
- Sine FM uses a half-sine FM envelope on the modulator contribution.
- Noise uses a deterministic 64-bit linear congruential generator.
- Sample-hold noise and downsample share the same stepped-ramp state machine.
- Hard clip, soft clip, bit crush, and ring mod preserve the app's generator
  conventions for bias, gain, and carrier parameters.
