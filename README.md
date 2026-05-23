# Warpenter

Pronounced `WARP-en-ter`, like "wave carpenter", because carpenters make tables.

Warpenter is an open-source TypeScript wavetable tool inspired by the original
Lambda Synthetics browser project.

The app renders a generator/effects table, drives a locally built WASM engine,
previews the resulting tables with an AudioWorklet, plots 2D/3D canvases, and
exports WAV or raw WT data.

If this project is useful to you, please support Lambda Synthetics and the wider
wavetable community that inspired it. More wavetable resources are available at
[wavetabl.es](https://wavetabl.es).

## Run

```sh
npm install
npm run install:emsdk
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Build

```sh
npm run build
```

`npm run build` rebuilds the ignored `public/generator.js` and
`public/generator.wasm` artifacts from the C++/Emscripten source in `wasm-src/`
before running the TypeScript/Vite build.

## Test

```sh
npm test
```

The test suite uses Vitest with jsdom for app-level behavior checks around
keyboard workflow, undo, randomization locks, presets, and modal controls.

## Keyboard Workflow

Warpenter supports a single-key workflow when no text or number field is
focused:

| Key | Action |
| --- | --- |
| `J` / `K` | Select next or previous generator |
| `N` / `P` | Select next or previous field in the selected generator |
| `E` | Focus the selected field for editing |
| `U` / `D` | Move the selected generator up or down |
| `M` | Mute or unmute the selected generator |
| `A` | Randomize all active unlocked generators |
| `G` | Randomize the selected generator |
| `R` | Randomize the selected row |
| `V` | Randomize the selected field |
| `1` / `2` / `3` | Toggle generator, row, or field randomization locks |
| `?` | Open the keyboard help |

Lock icons on generators, rows, and fields exclude those scopes from
randomization while keeping them editable.

## Presets

Presets are lazy-loaded static JSON files under `public/presets/`. To contribute
one, use the in-app save button to copy starter JSON, create one new
`public/presets/<preset-id>.json` file in a fork, edit the generated name and
optional description, and open a pull request.

Contributors do not need to edit `public/presets/index.json`. The GitHub Actions
pipeline regenerates it from the preset files for deployment and commits the
updated index back to `main` after merges. Index entries include the preset path,
description, last modified date, author, and GitHub profile link when the preset
JSON includes author metadata.

## License

Warpenter is licensed under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE).

## GitHub Pages

Warpenter is a static Vite app and can be hosted by GitHub Pages. The included
workflow builds the WASM engine from `wasm-src/`, builds the Vite app with the
repository name as its base path, and deploys `dist/` from pushes to `main`.

In the repository settings, set Pages to use GitHub Actions as the source.
If the repository stays private, GitHub Pages requires a plan that supports
Pages for private repositories; for open-source/public hosting, GitHub Free is
enough.

For a fully hands-off first deploy, add a `PAGES_ADMIN_TOKEN` repository secret
with Pages write and Administration write access. Without that secret, enable
Pages once in the repository settings before the first successful deployment.
The workflow is skipped while the repository is private unless the repository
variable `ENABLE_PRIVATE_PAGES` is set to `true`.

## WASM Source

The C++/Emscripten source for the generator lives in `wasm-src/`. The generated
`public/generator.js` and `public/generator.wasm` artifacts are intentionally
ignored; rebuild them from source when running or publishing the app.

To install the local Emscripten SDK:

```powershell
npm run install:emsdk
```

To rebuild only the WASM engine:

```powershell
npm run build:wasm
```

## Project Notes

- `src/wasm-engine.ts` loads the generated WASM engine.
- `src/synth.ts` is a readable TypeScript reference implementation of the
  generator math.
- Downloaded WAV files include a custom metadata chunk that lets this app
  restore the patch state on import.
