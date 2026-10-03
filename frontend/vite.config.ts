import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// base "./": every URL relative, so the app works under Desktop's /apps/<name>/ (docs/apps.md)
export default defineConfig({
    base: "./",
    plugins: [react()],
    build: { chunkSizeWarningLimit: 1500 }, // three.js
    server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
})
