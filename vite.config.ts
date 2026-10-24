import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Path aliases
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/bindings": resolve(__dirname, "./src/bindings.ts"),
    },
  },

  // Multiple entry points for main app and overlay
  build: {
    // macOS 15's WebKit; the extension's pages use top-level await.
    target: "safari18",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "src/overlay/index.html"),
        bubble: resolve(__dirname, "src/capture/bubble.html"),
        cast: resolve(__dirname, "src/capture/cast.html"),
        prompter: resolve(__dirname, "src/capture/prompter.html"),
        dictation: resolve(__dirname, "src/dictation/index.html"),
        card: resolve(__dirname, "src/card/index.html"),
        settings: resolve(__dirname, "src/settings/index.html"),
        editor: resolve(__dirname, "src/ext/editor.html"),
        video: resolve(__dirname, "src/ext/video.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
