<#
.SYNOPSIS  Removes the Retreat Print Agent. Settings, the ledger and logs in %LOCALAPPDATA%\RetreatSocialPrint are kept unless -RemoveData.
#>
param([string]$InstallDir = $PSScriptRoot, [switch]$RemoveData)
$ErrorActionPreference = "Stop"
Get-Process RetreatPrintAgent -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$InstallDir*" } | Stop-Process -Force
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name RetreatPrintAgent -ErrorAction SilentlyContinue
Remove-Item "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RetreatPrintAgent" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Retreat Social Print" -Recurse -Force -ErrorAction SilentlyContinue
if ($RemoveData) { Remove-Item "$env:LOCALAPPDATA\RetreatSocialPrint" -Recurse -Force -ErrorAction SilentlyContinue }
# this folder holds this very script, so it is deleted by a separate process after we exit
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", "Start-Sleep 2; Remove-Item -LiteralPath '$InstallDir' -Recurse -Force"
Write-Host "Retreat Print Agent removed. $(if (-not $RemoveData) { 'Settings and logs were kept.' })"
