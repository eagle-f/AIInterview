import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  server: {
    allowedHosts: true,
    port: 4399,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        secure: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  plugins: [vue()],
});
