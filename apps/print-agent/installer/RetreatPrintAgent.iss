; Inno Setup script for a standard Windows installer (setup.exe). Build with: iscc installer\RetreatPrintAgent.iss
; Run installer\build.ps1 first, so dist\app exists. Sign the result with your code-signing certificate.
#define AppVersion "1.0.0"
[Setup]
AppId={{6D0C3B3A-7A52-4D7C-9B2E-5A1E7B0C1A01}
AppName=Retreat Social Print Agent
AppVersion={#AppVersion}
AppPublisher=Retreat Arcade Solutions
DefaultDirName={autopf}\Retreat Social Print\Agent
DefaultGroupName=Retreat Social Print
OutputDir=..\dist
OutputBaseFilename=RetreatPrintAgent-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\RetreatPrintAgent.exe
CloseApplications=yes

[Files]
Source: "..\dist\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\Retreat Print Agent"; Filename: "{app}\RetreatPrintAgent.exe"

[Run]
Filename: "{app}\RetreatPrintAgent.exe"; Description: "Open the agent now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /F /IM RetreatPrintAgent.exe"; Flags: runhidden; RunOnceId: "StopAgent"
