#!/usr/bin/env bash
# Publica una versión de Folio para Windows (.exe, compilado de forma cruzada) y Linux
# (.AppImage con actualización automática y .deb) en GitHub Releases.
#
# Uso (desde la raíz del repositorio, en Linux):
#   ./scripts/release.sh 0.1.6 "Qué cambió"
#
# Requisitos: ver la sección «Publicar desde Linux» del README. La clave privada de firma
# debe estar en ~/.tauri/folio-updater.key (NUNCA en el repositorio).
set -euo pipefail

VERSION="${1:?Uso: ./scripts/release.sh VERSION [NOTAS]}"
NOTES="${2:-Mejoras y correcciones.}"
REPO="${REPO:-overfree}"
cd "$(dirname "$0")/.."
# en Ubuntu llvm-rc, lld-link… están en /usr/lib/llvm-<versión>/bin
LLVM_BIN="$(ls -d /usr/lib/llvm-*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="$HOME/.cargo/bin:${LLVM_BIN:+$LLVM_BIN:}$PATH"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Versión no válida: $VERSION" >&2; exit 1; }
KEY="$HOME/.tauri/folio-updater.key"
[[ -f "$KEY" ]] || { echo "No se encuentra la clave de firma $KEY" >&2; exit 1; }
OWNER="$(gh api user -q .login)" || { echo "gh no tiene sesión: ejecuta 'gh auth login'" >&2; exit 1; }
for tool in makensis clang lld-link llvm-rc cargo-xwin pkg-config; do
  command -v "$tool" >/dev/null || { echo "Falta $tool (ver README, «Publicar desde Linux»)" >&2; exit 1; }
done

# 1. versión en tauri.conf.json y Cargo.toml, y URL de actualizaciones con el usuario real
python3 - "$VERSION" "$OWNER" "$REPO" <<'PY'
import re, sys
v, owner, repo = sys.argv[1:]
p = "src-tauri/tauri.conf.json"
s = open(p, encoding="utf-8").read()
s = re.sub(r'"version": "\d+\.\d+\.\d+"', f'"version": "{v}"', s, count=1)
s = re.sub(r"https://github.com/[^/]+/[^/]+/releases/latest/download/latest.json",
           f"https://github.com/{owner}/{repo}/releases/latest/download/latest.json", s)
open(p, "w", encoding="utf-8", newline="\n").write(s)
p = "src-tauri/Cargo.toml"
s = open(p, encoding="utf-8").read()
s = re.sub(r'(?m)^version = "\d+\.\d+\.\d+"', f'version = "{v}"', s, count=1)
open(p, "w", encoding="utf-8", newline="\n").write(s)
PY

# 2. motor TeX (se descarga la primera vez) y compilaciones firmadas
node scripts/ensure-assets.mjs
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

echo "== Linux (AppImage + deb) =="
npx tauri build --bundles appimage,deb

echo "== Windows (instalador NSIS, compilación cruzada) =="
rustup target add x86_64-pc-windows-msvc >/dev/null
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

LIN=src-tauri/target/release/bundle
WIN=src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis
APPIMAGE="$(ls "$LIN"/appimage/Folio_"${VERSION}"_*.AppImage)"
DEB="$(ls "$LIN"/deb/Folio_"${VERSION}"_*.deb)"
EXE="$WIN/Folio_${VERSION}_x64-setup.exe"
for f in "$APPIMAGE" "$APPIMAGE.sig" "$DEB" "$EXE" "$EXE.sig"; do
  [[ -f "$f" ]] || { echo "No se generó $f" >&2; exit 1; }
done

# 3. latest.json: lo que consultan las apps instaladas para saber si hay versión nueva
BASE="https://github.com/$OWNER/$REPO/releases/download/v$VERSION"
LATEST="$(mktemp -d)/latest.json"
python3 - "$VERSION" "$NOTES" "$BASE" "$EXE" "$APPIMAGE" "$LATEST" <<'PY'
import json, os, sys, datetime
v, notes, base, exe, appimage, out = sys.argv[1:]
sig = lambda f: open(f + ".sig", encoding="utf-8").read().strip()
data = {
    "version": v,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "windows-x86_64": {"signature": sig(exe), "url": f"{base}/{os.path.basename(exe)}"},
        "linux-x86_64": {"signature": sig(appimage), "url": f"{base}/{os.path.basename(appimage)}"},
    },
}
open(out, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=2))
PY

# 4. commit, etiqueta y publicación
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -q -m "Folio $VERSION" -m "$NOTES" || true
git tag "v$VERSION"
git push -q origin main --tags
gh release create "v$VERSION" "$EXE" "$APPIMAGE" "$DEB" "$LATEST" \
  --repo "$OWNER/$REPO" --title "Folio $VERSION" --notes "$NOTES"
echo "Publicado: https://github.com/$OWNER/$REPO/releases/tag/v$VERSION"
