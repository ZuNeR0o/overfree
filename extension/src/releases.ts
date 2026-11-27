// Elige la actualización de la extensión entre las releases de GitHub (sin vscode: se prueba en Node).

export const REPO = "ZuNeR0o/overfree";
const TAG = "extension-v";
const ASSET = "folio-latex.vsix";

export type Release = {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  body?: string;
  assets?: { name: string; browser_download_url: string }[];
};

export type Update = { version: string; url: string; notes: string; page: string };

/** true si `a` es una versión posterior a `b` (x.y.z). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** La release de la extensión más nueva que `current`, con su .vsix de este repositorio; o null. */
export function pickUpdate(releases: Release[], current: string): Update | null {
  let best: Update | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name?.startsWith(TAG)) continue;
    const version = r.tag_name.slice(TAG.length);
    if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, current)) continue;
    const asset = r.assets?.find((a) => a.name === ASSET);
    // solo se descarga de las releases de este repositorio, nunca de otra URL que diga la API
    if (!asset?.browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`)) continue;
    if (!best || newer(version, best.version)) {
      best = { version, url: asset.browser_download_url, notes: r.body ?? "", page: r.html_url ?? `https://github.com/${REPO}/releases` };
    }
  }
  return best;
}
