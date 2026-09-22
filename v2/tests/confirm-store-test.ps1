param([Parameter(Mandatory=$true)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$launch = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
$browser = Get-CimInstance Win32_Process -Filter "ProcessId=$($launch.pid)"
if ($browser.CommandLine -notlike ('*' + $launch.directory + '*')) { throw 'Test process identity mismatch' }
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$launch.pid)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (-not $window) { throw 'Test browser window not found' }
$buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
$names = @()
foreach ($button in $buttons) {
  $name = $button.Current.Name
  $names += $name
  if ($name -eq 'Add extension' -and $button.Current.IsEnabled) {
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output 'Confirmed Add extension in disposable test browser.'
    exit 0
  }
}
$names | ConvertTo-Json
throw 'Add extension button not found; no action performed.'
