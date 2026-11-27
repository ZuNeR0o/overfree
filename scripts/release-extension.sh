#!/usr/bin/env bash
# Publica la extensión de VS Code/Antigravity en GitHub Releases y borra las releases
# anteriores de la extensión (las etiquetas git extension-v* se conservan). Las
# instalaciones existentes se actualizan solas desde la release nueva.
#
# Uso (desde la raíz del repositorio, con la versión ya subida en extension/package.json
# y la entrada en extension/CHANGELOG.md, todo en un commit en main):
#   ./scripts/release-extension.sh notas.md
set -euo pipefail
cd "$(dirname "$0")/.."
NOTES="${1:?Uso: ./scripts/release-extension.sh NOTAS.md}"
[[ -f "$NOTES" ]] || { echo "No existe $NOTES" >&2; exit 1; }
VERSION="$(node -p 'require("./extension/package.json").version')"
TAG="extension-v$VERSION"
[[ -z "$(git status --porcelain -- extension src)" ]] || { echo "Hay cambios sin commit en extension/ o src/" >&2; exit 1; }
gh release view "$TAG" >/dev/null 2>&1 && { echo "La release $TAG ya existe" >&2; exit 1; }

(cd extension && npm test && npm run package)
git push -q origin main
git tag "$TAG"
git push -q origin "$TAG"
gh release create "$TAG" extension/folio-latex.vsix --title "Overfree LaTeX para VS Code y Antigravity $VERSION" --notes-file "$NOTES" --latest=false

# solo queda la release nueva de la extensión; la de la app (v*) no se toca
for old in $(gh release list -L 100 --json tagName -q '.[].tagName' | grep '^extension-v' | grep -vx "$TAG"); do
  gh release delete "$old" --yes
done
echo "Publicado: $(gh release view "$TAG" --json url -q .url)"
