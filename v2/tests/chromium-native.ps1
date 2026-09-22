# Visual check of ordinary Chrome: no remote debugging, WebDriver or page scripts.
param([Parameter(Mandatory=$true)][string]$PlanFile, [ValidateRange(1,100)][int]$StartAt = 1, [switch]$CaptureOnly, [switch]$ScreenshotOnly, [ValidateRange(10,120)][int]$WaitSeconds = 40)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GoogleToolWindow {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
}
'@
[GoogleToolWindow]::SetProcessDPIAware() | Out-Null
$plan = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
$runtime = $plan.executable
if ((Get-Item -LiteralPath $runtime).VersionInfo.ProductVersion -ne $plan.version) { throw 'Incorrect Chromium build.' }
$auditRoot = $plan.root
Write-Output "Native Chromium audit: $auditRoot"
$profileNumber = 0
foreach ($profile in $plan.profiles) {
  $profileNumber++
  if ($profileNumber -lt $StartAt) { continue }
  $chromeArguments = @($profile.args | ForEach-Object { '"' + $_ + '"' })
  $chromeProcess = Start-Process -FilePath $runtime -ArgumentList $chromeArguments -WindowStyle Hidden -PassThru
  $targetWindow = [IntPtr]::Zero
  try {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
      $chromeProcess.Refresh()
      if ($chromeProcess.HasExited) { throw 'Test Chrome exited before showing a window.' }
      $targetWindow = $chromeProcess.MainWindowHandle
      if ($targetWindow -ne [IntPtr]::Zero) { break }
      Start-Sleep -Milliseconds 500
    }
    if ($targetWindow -eq [IntPtr]::Zero) { throw 'Cannot find the test Chrome window.' }
    # Bring only our test window forward so Chrome paints the page normally.
    [GoogleToolWindow]::ShowWindow($targetWindow, 1) | Out-Null
    [GoogleToolWindow]::MoveWindow($targetWindow, 15, 15, 1800, 1050, $true) | Out-Null
    [GoogleToolWindow]::SetForegroundWindow($targetWindow) | Out-Null
    Start-Sleep -Seconds 1
    # Reload our own test tab once after the initial Chrome startup.
    [GoogleToolWindow]::PostMessage($targetWindow, 0x0100, [IntPtr]0x74, [IntPtr]0x003F0001) | Out-Null
    [GoogleToolWindow]::PostMessage($targetWindow, 0x0101, [IntPtr]0x74, [IntPtr]0x003F0001) | Out-Null
    Write-Output "Profile $profileNumber`: waiting for page results, no debugger attached."
    Start-Sleep -Seconds $WaitSeconds
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
    if ($ScreenshotOnly) { continue }
    # Copy only the foreground test page's visible text, without attaching CDP.
    # Restore the clipboard after reading; never read text from another window.
    $savedClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
    try {
      if ([GoogleToolWindow]::GetForegroundWindow() -ne $targetWindow) { throw 'Test window lost focus; skipping page text capture.' }
      [System.Windows.Forms.Clipboard]::Clear()
      $keys = New-Object -ComObject WScript.Shell
      $keys.SendKeys('^a')
      $keys.SendKeys('^c')
      Start-Sleep -Milliseconds 350
      if ([GoogleToolWindow]::GetForegroundWindow() -ne $targetWindow) { throw 'Test window lost focus during page text capture.' }
      [System.Windows.Forms.Clipboard]::GetText() | Set-Content -LiteralPath (Join-Path $auditRoot "profile-$profileNumber.txt") -Encoding UTF8
      $keys.SendKeys('{RIGHT}')
    } finally {
      if ($null -ne $savedClipboard) { [System.Windows.Forms.Clipboard]::SetDataObject($savedClipboard, $true) }
      else { [System.Windows.Forms.Clipboard]::Clear() }
    }
  } finally {
    if ($targetWindow -ne [IntPtr]::Zero) { [GoogleToolWindow]::PostMessage($targetWindow, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
    # Closing a window can leave Chromium's background process alive. A restart
    # test must start a new browser process, not reuse that background instance.
    if (-not $chromeProcess.WaitForExit(5000)) {
      Write-Warning "Stopping lingering test process $($chromeProcess.Id) after closing its window."
      $chromeProcess.Kill()
      $chromeProcess.WaitForExit()
    }
  }
}
if ($CaptureOnly) { Write-Output "NATIVE_CAPTURE_COMPLETE $auditRoot"; exit 0 }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:ProgramFiles 'nodejs/node.exe' }
& $nodePath (Join-Path $PSScriptRoot 'native-results.cjs') $PlanFile
$auditExitCode = $LASTEXITCODE
Write-Output "NATIVE_AUDIT_COMPLETE $auditRoot"
exit $auditExitCode

