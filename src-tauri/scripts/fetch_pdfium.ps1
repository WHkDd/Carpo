param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("macos-arm64", "windows-x64")]
  [string] $Arch
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tauriDir = Split-Path -Parent $scriptDir
$pdfiumDir = Join-Path $tauriDir "pdfium"
$version = (Get-Content (Join-Path $pdfiumDir "VERSION") -Raw).Trim()
$cacheRoot = if ($env:CARPO_PDFIUM_CACHE_DIR) {
  $env:CARPO_PDFIUM_CACHE_DIR
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "carpo\pdfium"
} else {
  Join-Path $HOME ".cache\carpo\pdfium"
}

switch ($Arch) {
  "macos-arm64" {
    $assetArch = "mac-arm64"
    $outputArch = "macos-arm64"
    $libPath = "lib/libpdfium.dylib"
    $outputName = "libpdfium.dylib"
  }
  "windows-x64" {
    $assetArch = "win-x64"
    $outputArch = "windows-x64"
    $libPath = "bin/pdfium.dll"
    $outputName = "pdfium.dll"
  }
}

$asset = "pdfium-$assetArch.tgz"
$url = "https://github.com/bblanchon/pdfium-binaries/releases/download/$version/$asset"
$cacheDir = Join-Path $cacheRoot ($version -replace "/", "_")
$archive = Join-Path $cacheDir $asset
$extractDir = Join-Path $cacheDir ($asset -replace "\.tgz$", "")
$sharedOutputDir = Join-Path $cacheDir $outputArch
$outputDir = Join-Path $pdfiumDir $outputArch

New-Item -ItemType Directory -Force -Path $cacheDir, $extractDir, $sharedOutputDir, $outputDir | Out-Null

if (-not (Test-Path $archive)) {
  Invoke-WebRequest -Uri $url -OutFile $archive
}

$checksumLine = Get-Content (Join-Path $pdfiumDir "SHA256SUMS") |
  Where-Object { ($_ -split "\s+")[1] -eq $asset } |
  Select-Object -First 1

if (-not $checksumLine) {
  throw "missing checksum for $asset"
}

$expected = ($checksumLine -split "\s+")[0]
# Hash via .NET instead of Get-FileHash: when Windows PowerShell 5.1 is
# spawned from pwsh 7 (e.g. prepare_pdfium.mjs inside a GitHub Actions pwsh
# step), it inherits a PS7 PSModulePath and can't autoload the Utility
# module that defines Get-FileHash. The engine-level .NET API needs no
# module loading and works identically in both editions.
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $stream = [System.IO.File]::OpenRead((Resolve-Path $archive).ProviderPath)
  try {
    $hashBytes = $sha256.ComputeHash($stream)
  }
  finally {
    $stream.Dispose()
  }
}
finally {
  $sha256.Dispose()
}
$actual = ([System.BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
if ($actual -ne $expected) {
  Remove-Item -Force $archive
  throw "checksum mismatch for ${asset}: expected $expected, got $actual"
}

Remove-Item -Recurse -Force $extractDir
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
tar -xzf $archive -C $extractDir

$source = Join-Path $extractDir $libPath
if (-not (Test-Path $source)) {
  throw "expected $libPath in $asset"
}

$sharedDest = Join-Path $sharedOutputDir $outputName
Copy-Item -Force $source $sharedDest

$dest = Join-Path $outputDir $outputName
Copy-Item -Force $sharedDest $dest
Write-Output $dest
