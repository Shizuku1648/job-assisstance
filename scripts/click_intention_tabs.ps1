Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

$Root = Split-Path -Parent $PSScriptRoot
$ScreenshotDir = Join-Path $Root "runtime\screenshots"
$LogDir = Join-Path $Root "runtime\logs"
New-Item -ItemType Directory -Force -Path $ScreenshotDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Click-At([int]$x, [int]$y) {
  [Win32Mouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 180
  [Win32Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 90
  [Win32Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Screenshot([string]$name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $path = Join-Path $ScreenshotDir "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$name.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bmp.Dispose()
  return $path
}

$points = @(
  @{ name = "intention-1"; x = 500; y = 166 },
  @{ name = "intention-2"; x = 622; y = 166 },
  @{ name = "intention-3"; x = 746; y = 166 }
)

$results = @()
foreach ($point in $points) {
  Click-At $point.x $point.y
  Start-Sleep -Seconds 3
  $screenshot = Screenshot $point.name
  $targetsRaw = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9222/json" | Select-Object -ExpandProperty Content
  $results += [pscustomobject]@{
    name = $point.name
    x = $point.x
    y = $point.y
    screenshot = $screenshot
    targets = ($targetsRaw | ConvertFrom-Json)
  }
}

$logPath = Join-Path $LogDir "$(Get-Date -Format 'yyyyMMdd-HHmmss')-intention-clicks.json"
$results | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $logPath
Write-Output $logPath
