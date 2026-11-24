<#
.SYNOPSIS  Builds the Retreat Print Agent for Windows (self-contained: no .NET install needed on the print computer) and packs a ZIP.
.EXAMPLE   powershell -ExecutionPolicy Bypass -File installer\build.ps1
#>
param([string]$Configuration = "Release", [string]$Runtime = "win-x64")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = ([xml](Get-Content "$root\src\RetreatPrintAgent\RetreatPrintAgent.csproj")).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
$out = "$root\dist"; $app = "$out\app"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $app | Out-Null

Write-Host "Running unit tests..."
dotnet test "$root\tests\RetreatPrintAgent.Tests" -c $Configuration --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "Tests failed: not building a release." }

Write-Host "Publishing $version ($Runtime)..."
dotnet publish "$root\src\RetreatPrintAgent" -c $Configuration -r $Runtime --self-contained true -p:PublishSingleFile=false -p:DebugType=none -o $app --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "Publish failed." }

Copy-Item "$PSScriptRoot\install.ps1", "$PSScriptRoot\uninstall.ps1", "$PSScriptRoot\INSTALL.txt" $out
$zip = "$out\RetreatPrintAgent-$version-$Runtime.zip"
Compress-Archive -Path "$out\app", "$out\install.ps1", "$out\uninstall.ps1", "$out\INSTALL.txt" -DestinationPath $zip
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash
"$sha  $(Split-Path $zip -Leaf)" | Set-Content "$zip.sha256"
Write-Host "Built $zip"
Write-Host "SHA-256 $sha"
Write-Host "NOTE: the files are not code-signed. Sign RetreatPrintAgent.exe (and any installer) with your certificate before giving them to clients, or Windows SmartScreen will warn."
