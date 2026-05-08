param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("macos-arm64", "macos-x64", "windows-x64")]
  [string] $Arch
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tauriDir = Split-Path -Parent $scriptDir
$pdfiumDir = Join-Path $tauriDir "pdfium"
$version = (Get-Content (Join-Path $pdfiumDir "VERSION") -Raw).Trim()

switch ($Arch) {
  "macos-arm64" {
    $assetArch = "mac-arm64"
    $outputArch = "macos-arm64"
    $libPath = "lib/libpdfium.dylib"
    $outputName = "libpdfium.dylib"
  }
  "macos-x64" {
    $assetArch = "mac-x64"
    $outputArch = "macos-x64"
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
$cacheDir = Join-Path (Join-Path $pdfiumDir ".cache") ($version -replace "/", "_")
$archive = Join-Path $cacheDir $asset
$extractDir = Join-Path $cacheDir ($asset -replace "\.tgz$", "")
$outputDir = Join-Path $pdfiumDir $outputArch

New-Item -ItemType Directory -Force -Path $cacheDir, $extractDir, $outputDir | Out-Null

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
$actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
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

$dest = Join-Path $outputDir $outputName
Copy-Item -Force $source $dest
Write-Output $dest
