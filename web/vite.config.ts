import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

const base = process.env.VITE_BASE_PATH || '/'

export default defineConfig({
  plugins: [vue()],
  base: base.endsWith('/') ? base : `${base}/`,
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/v1': 'http://127.0.0.1:8080',
    },
  },
})
