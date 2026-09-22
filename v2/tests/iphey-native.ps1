# Visual check of ordinary Chrome: no remote debugging, WebDriver or page scripts.
param([ValidateRange(1, 2)][int]$Profiles = 2)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GoogleToolWindow {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
}
'@
$runtime = Join-Path $PSScriptRoot '..\runtime\151.0.7922.138\chrome-win64\chrome.exe'
if ((Get-Item -LiteralPath $runtime).VersionInfo.ProductVersion -ne '151.0.7922.138') { throw 'Incorrect Chrome build.' }
$auditRoot = Join-Path $PSScriptRoot ('..\artifacts\iphey-native-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $auditRoot | Out-Null
$auditRoot = (Resolve-Path -LiteralPath $auditRoot).Path
Write-Output "Native audit folder: $auditRoot"
foreach ($profileNumber in 1..$Profiles) {
  $profileDir = Join-Path $auditRoot "profile-$profileNumber-data"
  $chromeArguments = @("--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check', '--new-window', 'https://iphey.com/')
  $chromeProcess = Start-Process -FilePath $runtime -ArgumentList $chromeArguments -WindowStyle Hidden -PassThru
  $targetWindow = [IntPtr]::Zero
  try {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $chromeProcess.Refresh()
      if ($chromeProcess.HasExited) { throw 'Test Chrome exited before showing a window.' }
      $targetWindow = $chromeProcess.MainWindowHandle
      if ($targetWindow -ne [IntPtr]::Zero) { break }
      Start-Sleep -Milliseconds 500
    }
    if ($targetWindow -eq [IntPtr]::Zero) { throw 'Cannot find the test Chrome window.' }
    # Bring only our test window forward so Chrome paints the page normally.
    [GoogleToolWindow]::ShowWindow($targetWindow, 3) | Out-Null
    [GoogleToolWindow]::SetForegroundWindow($targetWindow) | Out-Null
    Start-Sleep -Seconds 1
    # Reload our own test tab once after the initial Chrome startup.
    [GoogleToolWindow]::PostMessage($targetWindow, 0x0100, [IntPtr]0x74, [IntPtr]0x003F0001) | Out-Null
    [GoogleToolWindow]::PostMessage($targetWindow, 0x0101, [IntPtr]0x74, [IntPtr]0x003F0001) | Out-Null
    Write-Output "Profile $profileNumber`: waiting for IPhey, no debugger attached."
    Start-Sleep -Seconds 40
    $rect = New-Object GoogleToolWindow+Rect
    [GoogleToolWindow]::GetWindowRect($targetWindow, [ref]$rect) | Out-Null
    $bitmap = New-Object System.Drawing.Bitmap(($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
      if (-not [GoogleToolWindow]::PrintWindow($targetWindow, $hdc, 2)) { throw 'Window capture failed.' }
    } finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
    try { $bitmap.Save((Join-Path $auditRoot "profile-$profileNumber.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $bitmap.Dispose() }
    Write-Output "Profile $profileNumber`: native screenshot saved."
  } finally {
    if ($targetWindow -ne [IntPtr]::Zero) { [GoogleToolWindow]::PostMessage($targetWindow, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
  }
}
@{ version='151.0.7922.138'; mode='Native window capture, no CDP or WebDriver'; checkedAt=[DateTime]::UtcNow.ToString('o'); scores=$null } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $auditRoot 'result.json') -Encoding UTF8
Write-Output "NATIVE_AUDIT_COMPLETE $auditRoot"
