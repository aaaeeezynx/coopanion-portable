[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ZipName = "Coopanion-0.2.4-win-x64-portable.zip"
$Zip = Join-Path $Root "_downloads\$ZipName"
$DownloadUrl = "https://github.com/Pal-AI-Lab/Coopanion/releases/download/v0.2.4/$ZipName"
$ExpectedSha256 = "054745e671f10b43ec29fefda66c8b8fcd84920d96c3aa3e71c779c5ba3df514"
$AppDir = Join-Path $Root "app\windows"
$AppExe = Join-Path $AppDir "Coopanion.exe"
$ProviderScript = Join-Path $Root "scripts\configure-opencode-provider.cjs"

function Invoke-ProviderMigration {
    if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
        return
    }
    if (-not (Test-Path -LiteralPath $ProviderScript -PathType Leaf)) {
        throw "Provider migration script is missing: $ProviderScript"
    }

    $previousData = $env:CORTICO_COMPANION_DATA
    $previousNodeMode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:CORTICO_COMPANION_DATA = Join-Path $Root "data"
        $env:ELECTRON_RUN_AS_NODE = "1"
        $process = Start-Process -FilePath $AppExe `
            -ArgumentList @($ProviderScript) `
            -Wait -PassThru -NoNewWindow
        if ($process.ExitCode -ne 0) {
            throw "OpenCodeGo provider migration failed with exit code $($process.ExitCode)."
        }
    }
    finally {
        if ($null -eq $previousData) {
            Remove-Item Env:CORTICO_COMPANION_DATA -ErrorAction SilentlyContinue
        }
        else {
            $env:CORTICO_COMPANION_DATA = $previousData
        }
        if ($null -eq $previousNodeMode) {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        else {
            $env:ELECTRON_RUN_AS_NODE = $previousNodeMode
        }
    }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "This installer must be run on Windows."
}
if (-not [System.Environment]::Is64BitOperatingSystem) {
    throw "The Coopanion v0.2.4 portable package requires 64-bit Windows."
}

if ((Test-Path -LiteralPath $AppDir) -and -not $Force) {
    if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
        throw "An incomplete app\windows directory exists. Re-run with -Force to replace it."
    }
    Write-Host "Coopanion is already installed."
    Invoke-ProviderMigration
    Write-Host "Use Install-Coopanion-Windows.cmd -Force to reinstall."
    exit 0
}

if (-not (Test-Path -LiteralPath $Zip -PathType Leaf)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Zip) -Force | Out-Null
    $Partial = "$Zip.part"
    try {
        Write-Host "Downloading Coopanion 0.2.4 for Windows x64..."
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $Partial -UseBasicParsing
        Move-Item -LiteralPath $Partial -Destination $Zip
    }
    finally {
        Remove-Item -LiteralPath $Partial -Force -ErrorAction SilentlyContinue
    }
}

$ActualSha256 = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSha256 -ne $ExpectedSha256) {
    throw "Checksum mismatch.`nExpected: $ExpectedSha256`nActual:   $ActualSha256"
}

$TempRoot = Join-Path $Root ".tmp\install-windows-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

try {
    Write-Host "Extracting Coopanion 0.2.4..."
    Expand-Archive -LiteralPath $Zip -DestinationPath $TempRoot -Force
    $FoundExe = Get-ChildItem -LiteralPath $TempRoot -Filter "Coopanion.exe" -File -Recurse |
        Select-Object -First 1
    if ($null -eq $FoundExe) {
        throw "Coopanion.exe was not found in the release archive."
    }

    $PayloadDir = Split-Path -Parent $FoundExe.FullName
    $AppParent = Split-Path -Parent $AppDir
    New-Item -ItemType Directory -Path $AppParent -Force | Out-Null

    if (Test-Path -LiteralPath $AppDir) {
        $BackupDir = Join-Path $AppParent "windows-backups"
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        $BackupName = "windows-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
        $BackupPath = Join-Path $BackupDir $BackupName
        Move-Item -LiteralPath $AppDir -Destination $BackupPath
        Write-Host "Previous installation moved to $BackupPath"
    }

    Move-Item -LiteralPath $PayloadDir -Destination $AppDir
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
    throw "Installation completed without the expected executable: $AppExe"
}

Invoke-ProviderMigration

Write-Host ""
Write-Host "Coopanion 0.2.4 for Windows x64 is installed."
Write-Host "Start it with: $Root\Start-Coopanion.cmd"
Write-Host ""
Write-Host "The private profile repository may request GitHub authentication on first launch."
