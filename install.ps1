<#
.SYNOPSIS
  Aius installer for Windows — downloads the prebuilt CLI and puts it on PATH.

.EXAMPLE
  irm https://aius.co/install.ps1 | iex

.NOTES
  Env knobs (set before running):
    $env:AIUS_VERSION      version to install, e.g. "v1.15.12" (default: latest release)
    $env:AIUS_INSTALL_DIR  install location (default: $HOME\.aius\bin)
    $env:AIUS_GH_REPO      GitHub repo for releases (default: aius-ai/aius-cli)
    $env:GITHUB_TOKEN      used for the "latest" lookup if you hit API rate limits
#>

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 defaults to TLS 1.0/1.1 which GitHub rejects.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$App        = 'aius'
$Repo       = if ($env:AIUS_GH_REPO)     { $env:AIUS_GH_REPO }     else { 'aius-ai/aius-cli' }
$InstallDir = if ($env:AIUS_INSTALL_DIR) { $env:AIUS_INSTALL_DIR } else { Join-Path $HOME '.aius\bin' }
$Version    = if ($env:AIUS_VERSION)     { $env:AIUS_VERSION }     else { 'latest' }

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "OK  $m" -ForegroundColor Green }
function Die($m)        { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

function Get-Arch {
  $a = $env:PROCESSOR_ARCHITECTURE
  if ($a -eq 'AMD64')  { return 'x64' }
  if ($a -eq 'ARM64')  { return 'arm64' }
  # 32-bit shell on a 64-bit OS (WOW64)
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { return 'x64' }
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { return 'arm64' }
  Die "unsupported architecture: $a"
}

# x64 ships an avx2 build and a "baseline" (no-avx2) build. Pick baseline only
# when the CPU lacks avx2; fail safe to baseline if detection is unavailable.
function Test-Avx2 {
  try {
    $sig = '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int feature);'
    $k = Add-Type -MemberDefinition $sig -Name 'AiusKernel32' -Namespace 'AiusInstall' -PassThru -ErrorAction Stop
    return [bool]$k::IsProcessorFeaturePresent(40)  # PF_AVX2_INSTRUCTIONS_AVAILABLE
  } catch { return $false }
}

function Get-AssetName($arch) {
  $name = "$App-windows-$arch"
  if ($arch -eq 'x64' -and -not (Test-Avx2)) { $name = "$name-baseline" }
  return $name
}

function Resolve-Version {
  if ($Version -ne 'latest') { return $Version }
  $api = "https://api.github.com/repos/$Repo/releases/latest"
  $headers = @{ 'User-Agent' = 'aius-installer' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
  try {
    return (Invoke-RestMethod -Uri $api -Headers $headers -UseBasicParsing).tag_name
  } catch {
    Die "could not find a published release for $Repo. Set `$env:AIUS_VERSION to a specific tag."
  }
}

function Add-ToUserPath($dir) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  $parts = $userPath -split ';' | Where-Object { $_ -ne '' }
  if ($parts -notcontains $dir) {
    $newPath = if ($userPath) { "$dir;$userPath" } else { $dir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  }
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$dir;$env:Path" }
}

# ---- main --------------------------------------------------------------------
$arch    = Get-Arch
$asset   = Get-AssetName $arch
$version = Resolve-Version
$url     = "https://github.com/$Repo/releases/download/$version/$asset.zip"

Write-Step "Installing $App $version ($asset) -> $InstallDir"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("aius-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $archive = Join-Path $tmp "$asset.zip"
  Write-Step "Downloading $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
  } catch {
    Die "download failed. Asset may not exist for this platform/version: $asset.zip"
  }

  # Fail closed: verify the archive against the published SHA-256 before
  # unpacking/running it. A missing or mismatched checksum aborts the install.
  Write-Step "Verifying checksum"
  $expected = $null
  try {
    $sumText  = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content
    $expected = ($sumText -split '\s+' | Where-Object { $_ })[0]
  } catch {}
  if (-not $expected) { Die "could not fetch checksum ($url.sha256) — refusing to install an unverified binary" }
  $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash
  if ($expected.ToLower() -ne $actual.ToLower()) {
    Die "checksum mismatch — expected $expected, got $actual. Aborting."
  }

  # Defense-in-depth against a path-traversal ("zip slip") archive: reject any
  # entry with an absolute path or a `..` component before extracting.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($e in $zip.Entries) {
      if ([System.IO.Path]::IsPathRooted($e.FullName) -or $e.FullName -match '(^|[\\/])\.\.([\\/]|$)') {
        Die "archive contains unsafe paths (path traversal) — aborting"
      }
    }
  } finally { $zip.Dispose() }

  Write-Step "Unpacking"
  Expand-Archive -Path $archive -DestinationPath $tmp -Force

  if (-not (Test-Path (Join-Path $tmp 'aius.exe'))) { Die "archive did not contain aius.exe" }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # The binary resolves uv/uvx as siblings — an asset missing them would
  # install a CLI that breaks at first Python use, so require all three.
  foreach ($f in 'aius.exe', 'uv.exe', 'uvx.exe') {
    $src = Join-Path $tmp $f
    if (-not (Test-Path $src)) { Die "archive is missing '$f' — corrupt or mis-built release asset" }
    Copy-Item -Force $src (Join-Path $InstallDir $f)
  }

  $exe = Join-Path $InstallDir 'aius.exe'
  $installed = $version
  try { $installed = (& $exe --version 2>$null) } catch {}
  Write-Ok "Installed $App $installed to $exe"

  Add-ToUserPath $InstallDir
  Write-Host ""
  Write-Host "Added $InstallDir to your PATH. Open a new terminal, then run: aius" -ForegroundColor DarkGray
  Write-Host "Or run it now: $exe" -ForegroundColor DarkGray
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
