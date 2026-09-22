param(
  [ValidateSet('sync', 'hooks', 'generate', 'patched', 'build')][string]$Stage = 'build',
  [string]$BuildRoot = 'E:\GoogleToolBuild151'
)
$ErrorActionPreference = 'Stop'
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:DEPOT_TOOLS_UPDATE = '0'
$env:PYTHONUNBUFFERED = '1'
$env:vs2022_install = 'C:\Program Files\Microsoft Visual Studio\2022\Community'
$compatTools = Join-Path $BuildRoot 'compat-tools'
New-Item -ItemType Directory -Path $compatTools -Force | Out-Null
# git_cache in this depot_tools revision still invokes git.bat on Windows.
@'
@echo off
"C:\Program Files\Git\cmd\git.exe" %*
'@ | Set-Content -LiteralPath (Join-Path $compatTools 'git.bat') -Encoding ASCII
$env:Path = $compatTools + ';' + (Join-Path $BuildRoot 'depot_tools\python-bin') + ';' + (Join-Path $BuildRoot 'depot_tools') + ';' + $env:Path
# Scoped to this process and children; do not change global Git settings.
$env:GIT_CONFIG_COUNT = '2'
$env:GIT_CONFIG_KEY_0 = 'core.autocrlf'
$env:GIT_CONFIG_VALUE_0 = 'false'
$env:GIT_CONFIG_KEY_1 = 'core.longpaths'
$env:GIT_CONFIG_VALUE_1 = 'true'
Set-Location -LiteralPath $BuildRoot
# Windows PowerShell wraps native stderr as ErrorRecord even for progress text.
# Judge native tools by their exit status below, not by stderr output.
$ErrorActionPreference = 'Continue'
switch ($Stage) {
  'sync' {
    @'
solutions = [{
  "name": "src",
  "url": "https://chromium.googlesource.com/chromium/src.git",
  "managed": False,
  "custom_deps": {},
  "custom_vars": {"checkout_pgo_profiles": False},
}]
target_os = ["win"]
'@ | Set-Content -LiteralPath (Join-Path $BuildRoot '.gclient') -Encoding ASCII
    & gclient.bat sync --no-history --nohooks --revision src@a96602f30358e9b5d256a0464e7e4d4bec223004 -j 8
  }
  'hooks' { & gclient.bat runhooks }
  'generate' {
    Set-Location -LiteralPath (Join-Path $BuildRoot 'src')
    New-Item -ItemType Directory -Path 'out\GoogleTool151' -Force | Out-Null
    @'
is_debug = false
is_component_build = true
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
target_cpu = "x64"
is_official_build = false
chrome_pgo_phase = 0
use_remoteexec = false
'@ | Set-Content -LiteralPath 'out\GoogleTool151\args.gn' -Encoding ASCII
    & .\buildtools\win\gn.exe gen out/GoogleTool151
  }
  'patched' {
    Set-Location -LiteralPath (Join-Path $BuildRoot 'src')
    & python3.bat (Join-Path $PSScriptRoot 'check-syntax.py') (Join-Path $BuildRoot 'src') --targets-only
    if ($LASTEXITCODE -ne 0) { throw 'Could not identify patched build targets' }
    $patchedTargets = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'patch-targets.json') -Raw | ConvertFrom-Json
    & autoninja.bat -C out/GoogleTool151 @patchedTargets -j 8
  }
  'build' {
    Set-Location -LiteralPath (Join-Path $BuildRoot 'src')
    & autoninja.bat -C out/GoogleTool151 chrome -j 8
    if ($LASTEXITCODE -eq 0) {
      $ErrorActionPreference = 'Stop'
      & (Join-Path $PSScriptRoot 'record-build.ps1') -BuildRoot $BuildRoot
    }
  }
}
if ($LASTEXITCODE -ne 0) { throw "$Stage failed with exit code $LASTEXITCODE" }
