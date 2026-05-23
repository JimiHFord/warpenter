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
