import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative paths so the build works from any folder (e.g. GitHub Pages /expenseTracker/).
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Expense Tracker',
        short_name: 'Expenses',
        description: 'Reads your bank statements and sorts spending, investments and self transfers.',
        theme_color: '#2a78d6',
        background_color: '#f4f4f2',
        display: 'standalone',
        start_url: './',
        scope: './',
        // Android: the installed app appears in the Share sheet for PDFs and spreadsheets.
        share_target: {
          action: './share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { files: [{ name: 'statements', accept: ['application/pdf', '.pdf', '.xls', '.xlsx', '.csv', 'text/csv'] }] },
        },
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The PDF worker is large; cache it so statements can be read offline.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,mjs,css,html,svg,png}'],
        // Receives files from the Share sheet (see public/share-target-sw.js).
        importScripts: ['share-target-sw.js'],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
