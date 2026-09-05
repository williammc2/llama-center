; Llama Center — Inno Setup script
; Build: ISCC installer\llama-center.iss (from project root)
;       — or just run build.bat, which passes the version.
; Output: dist\llama-center-setup-<version>.exe
;
; MyAppVersion is NOT defined here: it is passed by build.bat as
; /DMyAppVersion=<version>, single-sourced from package.json. (Running
; ISCC directly without /D fails fast — that's the point.)

#define MyAppName "Llama Center"
#define MyAppPublisher "Llama Center"
#define MyAppURL "https://github.com/williammc2/llama-center"
#define MyAppExeName "llama-center.exe"

[Setup]
AppId={{B7E4A6D2-3F19-4C8E-A5D1-90FC2E47A8B3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\llama-center
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
CloseApplications=yes
OutputDir=..\dist
OutputBaseFilename=llama-center-setup-{#MyAppVersion}
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\llama-center\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
