param([string]$BuildRoot = 'E:\GoogleToolBuild151', [switch]$ResumeBuild)
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetFullPath($BuildRoot) -ne 'E:\GoogleToolBuild151') { throw 'Unexpected build root' }
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$artifacts = Join-Path $projectRoot 'v2\artifacts'
$statusPath = Join-Path $artifacts 'build151-status.json'
$state = [ordered]@{stage='starting';version='151.0.7922.173';processId=$PID;buildRoot=$BuildRoot;startedAt=[DateTime]::UtcNow.ToString('o');compiled=$false;runtimeTested=$false}
function Status([string]$Stage) {
  $state.stage=$Stage
  $state.updatedAt=[DateTime]::UtcNow.ToString('o')
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}
function Native([string]$Exe,[string[]]$Arguments) {
  $previous=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  & $Exe @Arguments
  $code=$LASTEXITCODE
  $ErrorActionPreference=$previous
  if ($code -ne 0) { throw "Native command failed ($code): $Exe" }
}
Add-Type @'
using System.Runtime.InteropServices;
public static class GoogleTool151Power {
 [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
'@
try {
  $state.keepsSystemAwake=[GoogleTool151Power]::SetThreadExecutionState(2147483649) -ne 0
  Status 'preflight'
  if (-not $ResumeBuild -and (Get-PSDrive E).Free -lt 65GB) { throw 'Need at least 65 GiB free on E for independent build' }
  New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
  $depot=Join-Path $BuildRoot 'depot_tools'
  if (-not (Test-Path (Join-Path $depot 'gclient.bat'))) {
    Status 'copying_build_tools'
    & robocopy.exe 'E:\GoogleToolBuild149\depot_tools' $depot /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw 'Copying build tools failed' }
  }
  $env:DEPOT_TOOLS_WIN_TOOLCHAIN='0'
  $env:DEPOT_TOOLS_UPDATE='0'
  $env:PYTHONUNBUFFERED='1'
  $env:vs2022_install='C:\Program Files\Microsoft Visual Studio\2022\Community'
  $env:Path='C:\Program Files\Git\cmd;'+$depot+';'+$env:Path
  $env:GIT_CONFIG_COUNT='2'
  $env:GIT_CONFIG_KEY_0='core.autocrlf';$env:GIT_CONFIG_VALUE_0='false'
  $env:GIT_CONFIG_KEY_1='core.longpaths';$env:GIT_CONFIG_VALUE_1='true'
  $src=Join-Path $BuildRoot 'src'
  if ($ResumeBuild) {
    if (-not (Test-Path (Join-Path $src 'out\GoogleTool151\build.ninja'))) { throw 'Cannot resume without generated build' }
    $report=Get-Content (Join-Path $PSScriptRoot 'port-report.json') -Raw | ConvertFrom-Json
    foreach ($entry in $report.changes) {
      if ((Get-FileHash -LiteralPath (Join-Path $src $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Patched source mismatch: $($entry.path)" }
    }
  } else {
  if (-not (Test-Path (Join-Path $src '.git'))) {
    Status 'cloning_chromium151'
    Native 'C:\Program Files\Git\cmd\git.exe' @('clone','--depth=1','--single-branch','--branch','151.0.7922.173','https://chromium.googlesource.com/chromium/src.git',$src)
  }
  Status 'syncing_dependencies'
  Native "$PSHOME\powershell.exe" @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'build-local.ps1'),'-Stage','sync')
  Status 'running_hooks'
  Native "$PSHOME\powershell.exe" @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'build-local.ps1'),'-Stage','hooks')
  Status 'applying_verified_patch'
  $python=Join-Path $depot 'bootstrap-2@3_11_8_chromium_35_bin\python3\bin\python3.exe'
  Native $python @((Join-Path $PSScriptRoot 'apply.py'),$src)
  Status 'generating_build'
  Native "$PSHOME\powershell.exe" @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'build-local.ps1'),'-Stage','generate')
  }
  Status 'checking_patched_targets'
  Native "$PSHOME\powershell.exe" @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'build-local.ps1'),'-Stage','patched')
  Status 'compiling'
  Native "$PSHOME\powershell.exe" @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'build-local.ps1'),'-Stage','build')
  $manifest=Get-Content (Join-Path $PSScriptRoot 'build-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.compiled -ne $true -or $manifest.version -ne $state.version) { throw 'Invalid completed manifest' }
  $state.compiled=$true
  $state.executable=$manifest.executable
  Status 'compiled_pending_tests'
} catch {
  $state.failedStage=$state.stage
  $state.error=$_.Exception.Message
  Status 'failed'
  Write-Error $state.error
  exit 1
} finally {
  [GoogleTool151Power]::SetThreadExecutionState(2147483648) | Out-Null
  $state.keepsSystemAwake=$false
  Status $state.stage
}
