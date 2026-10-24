import { defineConfig } from "vite";
import { resolve } from "node:path";

// Two pages, one project: the landing at / and the live board at /app/.
export default defineConfig({
  root: "web",
  publicDir: "public",
  server: { port: 5173, fs: { allow: [".."] } },
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
