$ErrorActionPreference = 'Stop'
$version = '148.0.7778.215'
$archiveHash = '9EF3F471B7A6641B4224532522B29141CE3746E27D55788D88E2FD951F362579'
$runtimeRoot = Join-Path $PSScriptRoot 'runtime'
$downloads = Join-Path $runtimeRoot 'downloads'
$archive = Join-Path $downloads 'adryfish-148.zip'
$destination = Join-Path $runtimeRoot "adryfish-$version"
$executable = Join-Path $destination 'ungoogled-chromium_148.0.7778.215-1.1_windows_x64\chrome.exe'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
if (-not (Test-Path -LiteralPath $executable)) {
  if (-not (Test-Path -LiteralPath $archive)) {
    & curl.exe --fail --location --show-error --connect-timeout 15 --max-time 600 "https://github.com/adryfish/fingerprint-chromium/releases/download/$version/ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip" --output "$archive.partial"
    if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }
    if ((Get-FileHash -LiteralPath "$archive.partial" -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Download checksum mismatch.' }
    Move-Item -LiteralPath "$archive.partial" -Destination $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Archive checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
}
if ((Get-Item -LiteralPath $executable).VersionInfo.ProductVersion -ne $version) { throw 'Unexpected Chromium version.' }
$hashes = @{
  'chrome.exe' = '1867319E56BCABBC4681D8575C002106CE7B61B5290DC5EB34A37676805F6915'
  'chrome.dll' = '4DCCD72386D833FCCC3E861DD981BD708C4BF412393127606A57F205C69C8408'
}
foreach ($name in $hashes.Keys) {
  $item = Join-Path (Split-Path $executable) $name
  if ((Get-FileHash -LiteralPath $item -Algorithm SHA256).Hash -ne $hashes[$name]) { throw "Engine checksum mismatch: $name" }
}
Write-Output "Chromium Adryfish $version ready: $executable"
