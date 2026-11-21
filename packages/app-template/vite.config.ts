// Locked. The build agent may not change this file.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Screens only: this builds to static files in dist/. There is no server code in a mini-app.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The preview is opened through the build sandbox's own address.
    allowedHosts: [".vercel.run", "localhost", "127.0.0.1"],
  },
  build: { outDir: "dist", sourcemap: false },
});
