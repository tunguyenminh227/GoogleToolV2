$ErrorActionPreference = 'Stop'
$version = '151.0.7908.0'
$archiveHash = 'A4A0CD9749C4312944D5D61B69814E718EAC46F4193BE793649D87F2A7C6EFDF'
$runtimeRoot = Join-Path $PSScriptRoot 'runtime'
$downloads = Join-Path $runtimeRoot 'downloads'
$archive = Join-Path $downloads "tilion-fortress-$version-win-x64.zip"
$destination = Join-Path $runtimeRoot "fortress-$version"
$executable = Join-Path $destination 'tilion-fortress\chrome.exe'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
if (-not (Test-Path -LiteralPath $executable)) {
  if (-not (Test-Path -LiteralPath $archive)) {
    & curl.exe --fail --location --show-error --connect-timeout 15 --max-time 600 "https://github.com/tiliondev/fortress/releases/download/v$version/tilion-fortress-win-x64.zip" --output "$archive.partial"
    if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }
    if ((Get-FileHash -LiteralPath "$archive.partial" -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Download checksum mismatch.' }
    Move-Item -LiteralPath "$archive.partial" -Destination $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Archive checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
}
if ((Get-Item -LiteralPath $executable).VersionInfo.ProductVersion -ne $version) { throw 'Unexpected Chromium version.' }
$hashes = @{
  'chrome.exe' = 'B636C8331CB726D0B1F889968519A13335E17FCDA5C307EB0122F62B86E07C6B'
  'chrome.dll' = '95154CE0FC281C97872319228F4CE984F90C902C8D5EC2643FE483CAA633EA8F'
}
foreach ($name in $hashes.Keys) {
  $item = Join-Path (Split-Path $executable) $name
  if ((Get-FileHash -LiteralPath $item -Algorithm SHA256).Hash -ne $hashes[$name]) { throw "Engine checksum mismatch: $name" }
}
Write-Output "Chromium Fortress $version ready: $executable"
