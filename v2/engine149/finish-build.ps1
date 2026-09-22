param([int]$BuildProcessId, [switch]$TestOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$artifacts = Join-Path $projectRoot 'v2\artifacts'
$statusFile = Join-Path $artifacts 'build149-finish-status.json'
$status = [ordered]@{ stage = 'waiting_for_build'; buildProcessId = $BuildProcessId; watcherProcessId = $PID; startedAt = [DateTime]::UtcNow.ToString('o') }
Add-Type @'
using System.Runtime.InteropServices;
public static class GoogleToolBuildPower {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
function Save-Status {
  $status.updatedAt = [DateTime]::UtcNow.ToString('o')
  $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusFile -Encoding UTF8
}
function Invoke-Probe([string]$Executable, [string[]]$ProbeArguments, [string]$Label) {
  $status.stage = $Label
  Save-Status
  $probeProcess = Start-Process -FilePath $Executable -ArgumentList $ProbeArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $artifacts "$Label.stdout.log") -RedirectStandardError (Join-Path $artifacts "$Label.stderr.log")
  if ($null -eq $probeProcess.ExitCode -or $probeProcess.ExitCode -ne 0) { throw "$Label failed with exit code $($probeProcess.ExitCode); inspect its logs." }
}
try {
  if (-not $TestOnly) {
  if (-not $BuildProcessId) { throw 'BuildProcessId is required unless TestOnly is set.' }
  $buildProcess = Get-Process -Id $BuildProcessId
  # Hold a process handle so PID reuse cannot change the build we are waiting for.
  $null = $buildProcess.Handle
  $status.buildStartedAt = $buildProcess.StartTime.ToUniversalTime().ToString('o')
  # Temporary, process-scoped request; do not change Windows power settings.
  $status.keepsSystemAwake = [GoogleToolBuildPower]::SetThreadExecutionState(2147483649) -ne 0
  Save-Status
  while (-not $buildProcess.WaitForExit(5000)) { Save-Status }
  if ($buildProcess.ExitCode -ne 0) { throw "Chromium build failed with exit code $($buildProcess.ExitCode)." }
  }
  $manifestFile = Join-Path $PSScriptRoot 'build-manifest.json'
  $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
  if (-not $manifest.compiled -or $manifest.version -ne '149.0.7827.102') { throw 'Completed build manifest is missing or invalid.' }
  $env:GOOGLETOOL_ENGINE = '149'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $node = 'C:\Program Files\nodejs\node.exe'
  $electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
  Invoke-Probe $node @('v2/tests/chromium-audit.cjs', '--offline') 'build149-api-check'
  Invoke-Probe $node @('v2/tests/canvas-consistency.cjs') 'build149-canvas-check'
  Invoke-Probe $electron @('v2/tests/ui-smoke.cjs') 'build149-ui-check'
  $manifest.runtimeTested = $true
  $manifest | Add-Member -NotePropertyName runtimeLogs -NotePropertyValue @('build149-api-check.stdout.log', 'build149-canvas-check.stdout.log', 'build149-ui-check.stdout.log') -Force
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestFile -Encoding UTF8
  $status.stage = 'opening_app'
  Save-Status
  $trialApp = Start-Process -FilePath $electron -ArgumentList 'v2/main.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  $status.appProcessId = $trialApp.Id
  $status.stage = 'app_started'
  $status.ipheyTested = $false
  Save-Status
} catch {
  $status.failedStage = $status.stage
  $status.stage = 'failed'
  $status.error = $_.Exception.Message
  Save-Status
  Write-Error $status.error
  exit 1
} finally {
  [GoogleToolBuildPower]::SetThreadExecutionState(2147483648) | Out-Null
  $status.keepsSystemAwake = $false
  Save-Status
}
