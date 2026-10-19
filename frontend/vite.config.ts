import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Two builds from the same source:
//   npm run build      -> dist/       the local app, served by `ffc serve` (talks to the Python API)
//   npm run build:web  -> ../site-dist/  the public website for GitHub Pages: homepage, analysis
//                         (in-browser engine, public nextstrain.org builds only), run-locally page
export default defineConfig(({ mode }) => {
  if (mode === "web") {
    return {
      plugins: [react()],
      root: resolve(__dirname, "web"),
      base: "./", // works at https://<owner>.github.io/<repo>/
      envDir: __dirname,
      define: { "import.meta.env.VITE_TARGET": JSON.stringify("web") },
      server: { fs: { allow: [__dirname] } },
      build: {
        outDir: resolve(__dirname, "../site-dist"),
        emptyOutDir: true,
        chunkSizeWarningLimit: 6000,
        rollupOptions: {
          input: {
            home: resolve(__dirname, "web/index.html"),
            analysis: resolve(__dirname, "web/analysis/index.html"),
            local: resolve(__dirname, "web/local/index.html"),
          },
        },
      },
    };
  }
  return {
    plugins: [react()],
    // `npm run dev` proxies API calls to `ffc serve` on port 8050.
    server: { proxy: { "/api": "http://127.0.0.1:8050" } },
    // fixed file names so rebuilding overwrites dist/ in place (no stale hashed bundles)
    build: {
      outDir: "dist",
      chunkSizeWarningLimit: 5000,
      rollupOptions: { output: { entryFileNames: "assets/[name].js", chunkFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" } },
    },
  };
});
