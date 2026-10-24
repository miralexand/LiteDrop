[CmdletBinding()]
param(
  [string]$OutputDir = '',
  [switch]$SkipAssets
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDir) {
  $OutputDir = Join-Path $projectRoot 'dist'
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$buildDir = Join-Path $projectRoot 'build'
$bundleFile = Join-Path $buildDir 'server.cjs'
$seaConfigPath = Join-Path $buildDir 'sea-config.json'
$seaBlobPath = Join-Path $buildDir 'sea-prep.blob'
$stagedPublicDir = Join-Path $buildDir 'public'
$builtExe = Join-Path $buildDir 'LiteDrop.exe'

function Invoke-Node {
  param([string[]]$Arguments, [string]$Description)
  & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed (exit code $LASTEXITCODE)"
  }
}

Push-Location $projectRoot
try {
  if (-not $SkipAssets) {
    Write-Host '[1/4] Bundling server and frontend assets...'
    Invoke-Node -Arguments @('scripts/build-assets.js') -Description 'Asset build'
  } else {
    Write-Host '[1/4] Skipping asset build'
  }

  if (-not (Test-Path -LiteralPath $bundleFile)) {
    throw "Missing bundle: $bundleFile. Run npm run build:assets first."
  }

  Write-Host '[2/4] Generating Node SEA config...'
  $assetMap = [ordered]@{}
  if (Test-Path -LiteralPath $stagedPublicDir) {
    Get-ChildItem -LiteralPath $stagedPublicDir -Recurse -File | ForEach-Object {
      $relative = $_.FullName.Substring($stagedPublicDir.Length + 1).Replace('\', '/')
      $assetMap["public/$relative"] = $_.FullName.Replace('\', '/')
    }
  }
  if ($assetMap.Count -eq 0) {
    throw "No frontend assets found: $stagedPublicDir"
  }

  $seaConfig = [ordered]@{
    main = $bundleFile.Replace('\', '/')
    output = $seaBlobPath.Replace('\', '/')
    disableExperimentalSEAWarning = $true
    useSnapshot = $false
    useCodeCache = $false
    assets = $assetMap
  }
  $seaConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $seaConfigPath -Encoding UTF8

  Write-Host '[3/4] Building and injecting SEA blob...'
  Remove-Item -LiteralPath $seaBlobPath -Force -ErrorAction SilentlyContinue
  Invoke-Node -Arguments @('--experimental-sea-config', $seaConfigPath) -Description 'SEA blob build'

  $nodeExe = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  if (-not $nodeExe) {
    throw 'node.exe not found; cannot build the executable.'
  }
  if (Test-Path -LiteralPath $builtExe) {
    Remove-Item -LiteralPath $builtExe -Force
  }
  Copy-Item -LiteralPath $nodeExe -Destination $builtExe -Force
  Invoke-Node -Arguments @('scripts/inject-sea.js', $builtExe, $seaBlobPath) -Description 'SEA injection'

  Write-Host '[4/4] Writing distribution files...'
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  $finalExe = Join-Path $OutputDir 'LiteDrop.exe'
  Copy-Item -LiteralPath $builtExe -Destination $finalExe -Force

  $cloudflaredCandidates = @(
    (Join-Path $projectRoot 'cloudflared.exe'),
    (Join-Path $projectRoot 'cloudflared'),
    (Join-Path $projectRoot 'bin/cloudflared.exe'),
    (Join-Path $projectRoot 'bin/cloudflared')
  )
  $cloudflared = $cloudflaredCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($cloudflared) {
    Copy-Item -LiteralPath $cloudflared -Destination (Join-Path $OutputDir (Split-Path -Leaf $cloudflared)) -Force
    Write-Host "  Bundled cloudflared: $(Split-Path -Leaf $cloudflared)"
  } else {
    Write-Warning 'cloudflared.exe not found. Place it next to LiteDrop.exe to enable the public tunnel.'
  }

  $sizeMb = [math]::Round((Get-Item -LiteralPath $finalExe).Length / 1MB, 1)
  Write-Host "Done: $finalExe ($sizeMb MB)"
} finally {
  Pop-Location
}
