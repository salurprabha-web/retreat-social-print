<#
.SYNOPSIS  Installs the Retreat Print Agent. Run from the unzipped folder: right-click > Run with PowerShell (as administrator).
.PARAMETER InstallDir          Where to install (default: Program Files\Retreat Social Print\Agent).
.PARAMETER NoShortcut          Do not create the Start Menu shortcut.
.PARAMETER NoUninstallEntry    Do not register in "Apps and features" (used for testing).
#>
param([string]$InstallDir = "$env:ProgramFiles\Retreat Social Print\Agent", [switch]$NoShortcut, [switch]$NoUninstallEntry)
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "app"
if (-not (Test-Path "$src\RetreatPrintAgent.exe")) { throw "Run this script from the unzipped folder that contains the 'app' folder." }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$needsAdmin = $InstallDir.StartsWith($env:ProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or -not $NoUninstallEntry
if ($needsAdmin -and -not $isAdmin) { throw "Please run as administrator (right-click > Run as administrator)." }

Get-Process RetreatPrintAgent -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$InstallDir*" } | Stop-Process -Force
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item "$src\*" $InstallDir -Recurse -Force
Copy-Item "$PSScriptRoot\uninstall.ps1" $InstallDir -Force
$exe = Join-Path $InstallDir "RetreatPrintAgent.exe"
$version = (Get-Item $exe).VersionInfo.ProductVersion

if (-not $NoShortcut) {
  $dir = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Retreat Social Print"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut("$dir\Retreat Print Agent.lnk")
  $s.TargetPath = $exe; $s.WorkingDirectory = $InstallDir; $s.Description = "Retreat Social Print: print agent"; $s.Save()
}
if (-not $NoUninstallEntry) {
  $k = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RetreatPrintAgent"
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty $k DisplayName "Retreat Social Print Agent"; Set-ItemProperty $k DisplayVersion $version
  Set-ItemProperty $k Publisher "Retreat Arcade Solutions"; Set-ItemProperty $k InstallLocation $InstallDir
  Set-ItemProperty $k UninstallString "powershell.exe -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
  Set-ItemProperty $k DisplayIcon $exe
  Set-ItemProperty $k NoModify 1 -Type DWord; Set-ItemProperty $k NoRepair 1 -Type DWord
}
Write-Host "Installed Retreat Print Agent $version to $InstallDir"
Write-Host "Open it from the Start Menu, press 'Pair this computer' and enter the code from the event's Printers page."
