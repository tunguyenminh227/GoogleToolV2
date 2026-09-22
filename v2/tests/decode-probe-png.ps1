param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
foreach ($file in Get-ChildItem -LiteralPath $Root -Filter '*.png' -Recurse -File) {
  if ($file.BaseName -notin @('blank', 'solid', 'solid-default', 'pattern', 'text')) { continue }
  $bitmap = [System.Drawing.Bitmap]::FromFile($file.FullName)
  try {
    $bytes = New-Object byte[] ($bitmap.Width * $bitmap.Height * 4)
    $index = 0
    for ($y = 0; $y -lt $bitmap.Height; $y++) {
      for ($x = 0; $x -lt $bitmap.Width; $x++) {
        $pixel = $bitmap.GetPixel($x, $y)
        $bytes[$index++] = $pixel.R; $bytes[$index++] = $pixel.G
        $bytes[$index++] = $pixel.B; $bytes[$index++] = $pixel.A
      }
    }
    [System.IO.File]::WriteAllBytes([System.IO.Path]::ChangeExtension($file.FullName, '.rgba'), $bytes)
  } finally { $bitmap.Dispose() }
}
