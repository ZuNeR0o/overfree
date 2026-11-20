// Descarga el motor BusyTeX (WASM + paquetes de TeX Live) a public/core la primera vez.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const patch = () => spawnSync(process.execPath, ["scripts/patch-busytex.mjs"], { stdio: "inherit" });

if (existsSync("public/core/busytex/texlive-basic.js")) {
  patch();
  process.exit(0);
}

console.log("\nDescargando el motor LaTeX (BusyTeX). Solo ocurre la primera vez y puede tardar varios minutos…\n");
const result = spawnSync("npx", ["texlyre-busytex", "download-assets"], {
  stdio: "inherit",
  shell: true, // necesario en Windows para ejecutar npx
});

if (result.status === 0) patch();
if (result.status !== 0) {
  console.error(
    "\nNo se pudo descargar el motor. Revisa tu conexión y vuelve a correr: npm run setup\n",
  );
}
process.exit(result.status ?? 1);
