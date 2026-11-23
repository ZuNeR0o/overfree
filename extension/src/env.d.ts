// Importaciones "?url" de Vite (src/pdfview.ts); en el webview las resuelve build.mjs.
declare module "*?url" {
  const url: string;
  export default url;
}
