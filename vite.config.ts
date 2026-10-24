import { defineConfig } from "vite";
import { resolve } from "node:path";

// Two pages, one project: the landing at / and the live board at /app/.
export default defineConfig({
  root: "web",
  publicDir: "public",
  server: {
    port: 5173,
    fs: { allow: [".."] },
    // The board's demo controls reach agent/demo-control.ts through here.
    proxy: { "/demo-control": { target: "http://127.0.0.1:4311", rewrite: p => p.replace(/^\/demo-control/, "") } },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "web/index.html"),
        app: resolve(__dirname, "web/app/index.html"),
      },
    },
  },
});
