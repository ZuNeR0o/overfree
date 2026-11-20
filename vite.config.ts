import { defineConfig } from "vite";

// Dos páginas: el editor (index.html) y la ventana aparte del PDF (pdf.html).
export default defineConfig({
  server: {
    // no vigilar la compilación de Rust ni el motor TeX: Vite se caía con EBUSY
    watch: { ignored: ["**/src-tauri/**", "**/dist/**", "**/public/core/**", "**/shell/**"] },
  },
  build: {
    rollupOptions: {
      input: { main: "index.html", pdf: "pdf.html" },
    },
    chunkSizeWarningLimit: 2000,
  },
});
