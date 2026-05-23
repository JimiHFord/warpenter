$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$toolsDir = Join-Path $root ".tools"
$emsdkDir = Join-Path $toolsDir "emsdk"
$emsdk = Join-Path $emsdkDir "emsdk.bat"
$emsdkEnv = Join-Path $emsdkDir "emsdk_env.bat"
$emsdkVersion = if ($env:EMSDK_VERSION) { $env:EMSDK_VERSION } else { "5.0.7" }

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

if (Test-Path $emsdk) {
  git -C $emsdkDir pull --ff-only
} else {
  git clone https://github.com/emscripten-core/emsdk.git $emsdkDir
}

& $emsdk install $emsdkVersion
& $emsdk activate $emsdkVersion

cmd /c "`"$emsdkEnv`" >NUL && emcc --version"
if ($LASTEXITCODE -ne 0) {
  throw "Unable to initialize Emscripten SDK"
}
