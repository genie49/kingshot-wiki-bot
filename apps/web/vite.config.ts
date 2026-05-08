import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.ico", "pwa-192x192.png", "pwa-512x512.png"],
      manifest: {
        name: "Kingshot WIKI",
        short_name: "Kingshot",
        description: "Kingshot wiki knowledge base and chat assistant.",
        start_url: "/chat",
        scope: "/",
        display: "standalone",
        background_color: "#fafaf7",
        theme_color: "#c25a35",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webp}"]
      }
    })
  ],
  server: {
    port: 5173
  },
  preview: {
    allowedHosts: true
  }
});
