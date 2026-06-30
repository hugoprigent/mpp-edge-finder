import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"]
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: false
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787"
    }
  }
});
