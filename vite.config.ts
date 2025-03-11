import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // Add this alias for Buffer polyfill
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      // Define globals for browser compatibility
      define: {
        global: "globalThis",
      },
    },
  },
});
