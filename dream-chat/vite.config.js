import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes dist/index.html reference assets relatively, so the built
// bundle works when Electron loads it via file:// (HEMLOCK_PROD_UI=1 launch).
// Absolute /assets/... paths resolve to the filesystem root under file:// and
// render a blank window.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
