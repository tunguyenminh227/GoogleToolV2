param([string]$BuildRoot = 'E:\GoogleToolBuild149')
$ErrorActionPreference = 'Stop'
$source = Join-Path $BuildRoot 'src'
$output = Join-Path $source 'out\GoogleTool149'
$executable = Join-Path $output 'chrome.exe'
$version = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
if ($version -ne '149.0.7827.102') { throw "Unexpected binary version: $version" }
$port = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'port-report.json') -Raw | ConvertFrom-Json
foreach ($entry in $port.changes) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $source $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.sha256) { throw "Patch output differs from port report: $($entry.path)" }
}
$hashes = [ordered]@{}
$runtimeFiles = @('chrome.exe', 'chrome.dll', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'icudtl.dat')
# Fingerprint code lives in several DLLs in a component build.
$runtimeFiles += @(Get-ChildItem -LiteralPath $output -Filter '*.dll' -File | Select-Object -ExpandProperty Name)
foreach ($name in ($runtimeFiles | Sort-Object -Unique)) {
  $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $output $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$report = [ordered]@{
  version = $version
  compiled = $true
  executable = $executable
  recordedAt = [DateTime]::UtcNow.ToString('o')
  chromiumCommit = $port.chromiumCommit
  v8Commit = $port.v8Commit
  patchSha256 = $port.patchSha256
  args = [string](Get-Content -LiteralPath (Join-Path $output 'args.gn') -Raw)
  hashes = $hashes
  runtimeTested = $false
  ipheyTested = $false
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'build-manifest.json') -Encoding UTF8
Write-Output "Recorded Chromium $version build; runtime tests still required."
