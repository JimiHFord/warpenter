$ErrorActionPreference = "Stop"
if (-not $env:EMSDK_QUIET) {
  $env:EMSDK_QUIET = "1"
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $PSScriptRoot "src\generator.cpp"
$outDir = if ($env:WASM_OUT_DIR) { $env:WASM_OUT_DIR } else { Join-Path $root "public" }
$output = Join-Path $outDir "generator.js"
$localEmsdkEnv = Join-Path $root ".tools\emsdk\emsdk_env.bat"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (Test-Path $localEmsdkEnv) {
  cmd /c "`"$localEmsdkEnv`" >NUL && emcc --version >NUL"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to initialize local Emscripten SDK"
  }

  $emccArgs = @(
    "`"$source`"",
    "-std=c++17",
    "-O3",
    "--bind",
    "-s WASM=1",
    "-s ALLOW_MEMORY_GROWTH=1",
    "-s ENVIRONMENT=web,worker,node",
    "-s MODULARIZE=0",
    "-s EXPORT_NAME=Module",
    "-o `"$output`""
  ) -join " "

  $command = "`"$localEmsdkEnv`" >NUL && emcc $emccArgs"

  cmd /c $command
  if ($LASTEXITCODE -ne 0) {
    throw "Emscripten build failed"
  }
  exit 0
}

emcc $source `
  -std=c++17 `
  -O3 `
  --bind `
  -s WASM=1 `
  -s ALLOW_MEMORY_GROWTH=1 `
  -s ENVIRONMENT=web,worker,node `
  -s MODULARIZE=0 `
  -s EXPORT_NAME=Module `
  -o $output
