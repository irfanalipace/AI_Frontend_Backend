import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // ffmpeg.wasm needs SharedArrayBuffer, which requires these COOP/COEP headers.
    // Without them the in-browser audio extraction won't load.
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy':   'same-origin',
    },
    proxy: {
      '/api':       { target: 'http://localhost:5050', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:5050', ws: true }
    }
  },
  // ffmpeg.wasm ships large WebAssembly + worker files; tell Vite not to inline them.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  }
})