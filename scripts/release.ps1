<#
  Publica una versión nueva de Folio en GitHub Releases con actualización automática.

  Uso (desde la raíz del repositorio):  .\scripts\release.ps1 -Version 0.1.5 -Notes "Qué cambió"

  Requisitos: gh (con sesión iniciada), Rust, Node, y la clave privada de firma en
  %USERPROFILE%\.tauri\folio-updater.key (NUNCA la subas al repositorio: sin ella no
  se pueden publicar actualizaciones, y con ella cualquiera podría firmarlas).
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "Mejoras y correcciones.",
  [string]$Repo = "overfree"
)
# "Continue": en PowerShell 5.1 cualquier línea en stderr de un programa (npm, tauri,
# git) cuenta como error; se decide por $LASTEXITCODE de cada paso.
$ErrorActionPreference = "Continue"
Set-Location (Split-Path $PSScriptRoot -Parent)
function Assert-Ok($what) { if ($LASTEXITCODE -ne 0) { throw "Falló: $what (código $LASTEXITCODE)" } }

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = "C:\Program Files\GitHub CLI\gh.exe" }
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Versión no válida: $Version (usa por ejemplo 0.1.5)" }
$key = "$env:USERPROFILE\.tauri\folio-updater.key"
if (-not (Test-Path $key)) { throw "No se encuentra la clave de firma $key" }
$owner = (& $gh api user -q .login).Trim()
if (-not $owner) { throw "gh no tiene sesión iniciada: ejecuta 'gh auth login'" }

function Set-Utf8NoBom($path, $text) { [IO.File]::WriteAllText((Resolve-Path $path), $text, (New-Object Text.UTF8Encoding $false)) }

# 1. versión en tauri.conf.json y Cargo.toml (y URL de actualizaciones con el usuario real)
$conf = [IO.File]::ReadAllText((Resolve-Path "src-tauri\tauri.conf.json"))
$conf = $conf -replace '"version": "\d+\.\d+\.\d+"', "`"version`": `"$Version`""
$conf = $conf -replace 'https://github.com/[^/]+/[^/]+/releases/latest/download/latest.json', "https://github.com/$owner/$Repo/releases/latest/download/latest.json"
Set-Utf8NoBom "src-tauri\tauri.conf.json" $conf
$cargo = [IO.File]::ReadAllText((Resolve-Path "src-tauri\Cargo.toml"))
$cargo = $cargo -replace '(?m)^version = "\d+\.\d+\.\d+"', "version = `"$Version`""
Set-Utf8NoBom "src-tauri\Cargo.toml" $cargo

# 2. compilación firmada
$env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($key)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run app:build
if ($LASTEXITCODE -ne 0) { throw "Falló la compilación" }

$bundle = "src-tauri\target\release\bundle\nsis"
$exe = Get-Item "$bundle\Folio_${Version}_x64-setup.exe"
$sig = Get-Content "$($exe.FullName).sig" -Raw

# 3. latest.json: lo que consulta la app para saber si hay versión nueva
$url = "https://github.com/$owner/$Repo/releases/download/v$Version/$($exe.Name)"
$manifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{ "windows-x86_64" = [ordered]@{ signature = $sig.Trim(); url = $url } }
}
$latest = "$bundle\latest.json"
Set-Content $latest "" ; Set-Utf8NoBom $latest ($manifest | ConvertTo-Json -Depth 5)

# 4. commit, etiqueta y publicación
& $git add -A
& $git commit -q -m "Folio $Version`n`n$Notes"
& $git tag "v$Version"; Assert-Ok "git tag"
& $git push -q origin main --tags; Assert-Ok "git push"
& $gh release create "v$Version" $exe.FullName $latest --repo "$owner/$Repo" --title "Folio $Version" --notes $Notes
Assert-Ok "publicación en GitHub"
Write-Host "`nPublicado: https://github.com/$owner/$Repo/releases/tag/v$Version"
