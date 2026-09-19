#define MyAppName "SellerBooks Admin"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "SellerBooks"
#define MyAppExeName "SellerBooks Admin.exe"

[Setup]
AppId={{B7F2A4E5-2F70-4E53-9A12-ADMINSELLERBOOKS}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\SellerBooks Admin
DefaultGroupName=SellerBooks Admin
OutputDir=..\artifacts
OutputBaseFilename=SellerBooks Admin Setup
SetupIconFile=SellerBooks Admin.ico
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
DisableProgramGroupPage=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\publish-admin\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
Source: "..\MicrosoftEdgeWebView2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{autodesktop}\SellerBooks Admin"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\SellerBooks Admin"; Filename: "{app}\{#MyAppExeName}"

[Run]
Filename: "{tmp}\MicrosoftEdgeWebView2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Memeriksa Microsoft Edge WebView2 Runtime..."; Flags: waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "Jalankan SellerBooks Admin"; Flags: nowait postinstall skipifsilent
