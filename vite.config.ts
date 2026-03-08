import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/navi-price': {
        target: 'https://aggregator-api.naviprotocol.io',
        changeOrigin: true,
        rewrite: () => '/bridge-coins/price',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', 'https://app.naviprotocol.io')
            proxyReq.setHeader('referer', 'https://app.naviprotocol.io/')
            proxyReq.setHeader('user-agent', 'Mozilla/5.0')
          })
        },
      },
    },
  },
})
