import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: Change '/orders/' to match your subdirectory on GoDaddy
// Example: if you upload to public_html/orders/ → use '/orders/'
// Example: if you upload to public_html/app/   → use '/app/'
// Example: if you upload to root (public_html/) → use '/'
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2018',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  }
})
