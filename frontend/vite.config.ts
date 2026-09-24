import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@propsim/types": path.resolve(__dirname, "./src/vendor/types.ts"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/react-router") ||
              id.includes("/@radix-ui/") ||
              id.includes("/@tanstack/") ||
              id.includes("/zustand/") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("/lucide-react/")) {
              return "vendor-icons";
            }
          }
        },
      },
    },
  },
  server: {
    host: true, // bind 0.0.0.0 — required for container/remote previews
    port: 5173,
    allowedHosts: true, // accept proxied preview hosts
    proxy: {
      "/api": {
        target: "http://localhost:8080", // kryptto backend (server/)
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
