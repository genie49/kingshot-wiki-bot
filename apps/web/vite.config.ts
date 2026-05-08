import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: [
        "favicon.ico",
        "pwa-192x192.png",
        "pwa-512x512.png",
        "maskable-192x192.png",
        "maskable-512x512.png",
        "pwa-screenshot-wide.png",
        "pwa-screenshot-mobile.png"
      ],
      manifest: {
        id: "/chat",
        name: "Kingshot WIKI",
        short_name: "Kingshot",
        description: "Kingshot wiki knowledge base and chat assistant.",
        lang: "ko",
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
            purpose: "any"
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/maskable-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "/maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ],
        screenshots: [
          {
            src: "/pwa-screenshot-wide.png",
            sizes: "1280x720",
            type: "image/png",
            form_factor: "wide",
            label: "Kingshot WIKI desktop chat"
          },
          {
            src: "/pwa-screenshot-mobile.png",
            sizes: "390x844",
            type: "image/png",
            form_factor: "narrow",
            label: "Kingshot WIKI mobile chat"
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
