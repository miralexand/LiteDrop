[CmdletBinding()]
param(
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDir) {
  $OutputDir = Join-Path $projectRoot 'dist'
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$androidDir = Join-Path $projectRoot 'android'
$apkPath = Join-Path $androidDir 'app/build/outputs/apk/release/app-release.apk'

function Find-AndroidSdk {
  $candidates = @()
  if ($env:ANDROID_HOME) { $candidates += $env:ANDROID_HOME }
  if ($env:ANDROID_SDK_ROOT) { $candidates += $env:ANDROID_SDK_ROOT }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Android/Sdk') }
  $candidates += 'C:\Android\Sdk'

  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    if (Test-Path -LiteralPath (Join-Path $candidate 'platforms/android-34')) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Find-Gradle {
  if ($env:GRADLE_HOME) {
    $fromHome = Join-Path $env:GRADLE_HOME 'bin/gradle.bat'
    if (Test-Path -LiteralPath $fromHome) { return $fromHome }
  }
  $command = Get-Command gradle -CommandType Application -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  if ($env:USERPROFILE) {
    $wrapperRoot = Join-Path $env:USERPROFILE '.gradle/wrapper/dists'
    if (Test-Path -LiteralPath $wrapperRoot) {
      $cached = Get-ChildItem -LiteralPath $wrapperRoot -Recurse -Filter 'gradle.bat' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\gradle-[0-9.]+\\bin\\gradle\.bat$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
      if ($cached) { return $cached.FullName }
    }
  }
  return $null
}

$sdk = Find-AndroidSdk
if (-not $sdk) {
  throw 'Android SDK (platform android-34) not found. Set ANDROID_HOME or install the SDK.'
}
$gradle = Find-Gradle
if (-not $gradle) {
  throw 'Gradle not found. Install Gradle 8.7+ or open the android folder once in Android Studio.'
}

Write-Host "[1/3] Using Android SDK: $sdk"
$localProperties = Join-Path $androidDir 'local.properties'
$sdkProperty = $sdk.Replace('\', '/')
Set-Content -LiteralPath $localProperties -Value "sdk.dir=$sdkProperty" -Encoding ASCII

Write-Host "[2/3] Building release APK with Gradle..."
Push-Location $androidDir
try {
  & $gradle 'assembleRelease' '--no-daemon' '--console=plain'
  if ($LASTEXITCODE -ne 0) {
    throw "Gradle build failed (exit code $LASTEXITCODE)"
  }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $apkPath)) {
  throw "APK not found: $apkPath"
}

Write-Host '[3/3] Writing distribution file...'
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$finalApk = Join-Path $OutputDir 'LiteDrop.apk'
Copy-Item -LiteralPath $apkPath -Destination $finalApk -Force
$size = (Get-Item -LiteralPath $finalApk).Length
$sizeText = if ($size -lt 1MB) {
  "$([math]::Round($size / 1KB, 0)) KB"
} else {
  "$([math]::Round($size / 1MB, 1)) MB"
}
Write-Host "Done: $finalApk ($sizeText)"
