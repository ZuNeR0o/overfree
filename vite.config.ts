import { defineConfig } from "vite";

// Dos páginas: el editor (index.html) y la ventana aparte del PDF (pdf.html).
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: "index.html", pdf: "pdf.html" },
    },
    chunkSizeWarningLimit: 2000,
  },
});
