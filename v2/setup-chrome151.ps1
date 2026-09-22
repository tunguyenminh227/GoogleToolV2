$ErrorActionPreference = 'Stop'
$chromeVersion = '151.0.7922.138'
# Hashes recorded from Google's HTTPS download for this exact build.
# Chrome for Testing Windows binaries are unsigned (upstream issue #175).
$archiveHash = '864A03252382FCFAF0475A1D7CAD30B99CB54883060DCB5526249F4CA08AA03A'
$executableHash = '38E630415F0746C8390D3959E9C72A1A72FFDE6E2644AE686303514BADBE0C0A'
$runtimeRoot = Join-Path $PSScriptRoot 'runtime'
$archiveDir = Join-Path $runtimeRoot 'downloads'
$archive = Join-Path $archiveDir "chrome-$chromeVersion-win64.zip"
$destination = Join-Path $runtimeRoot $chromeVersion
$executable = Join-Path $destination 'chrome-win64\chrome.exe'
$url = "https://storage.googleapis.com/chrome-for-testing-public/$chromeVersion/win64/chrome-win64.zip"
New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $executable)) {
  if (-not (Test-Path -LiteralPath $archive)) {
    & curl.exe --fail --location --show-error --connect-timeout 15 --max-time 600 $url --output "$archive.partial"
    if ($LASTEXITCODE -ne 0) { throw 'Download Chrome failed. Run the setup script again.' }
    Move-Item -LiteralPath "$archive.partial" -Destination $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) { throw 'Chrome archive checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
}
$actualVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
if ($actualVersion -ne $chromeVersion) { throw "Unexpected Chrome version: $actualVersion" }
if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $executableHash) { throw 'Chrome executable checksum mismatch.' }
Write-Output "Chrome $actualVersion ready: $executable"
