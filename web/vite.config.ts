import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev (npm run dev) /api is proxied to the API on :3000. In Docker, nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
