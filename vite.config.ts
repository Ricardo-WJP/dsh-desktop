import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'

const rendererRoot = fileURLToPath(new URL('./src/renderer/', import.meta.url))
const rendererOutput = fileURLToPath(new URL('./build/renderer/', import.meta.url))

export const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
export const DEVELOPMENT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' http://127.0.0.1:5173; style-src 'self' 'unsafe-inline' http://127.0.0.1:5173; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"

const CSP_META = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/

function cspPlugin(command: 'build' | 'serve'): Plugin {
  const csp = command === 'serve' ? DEVELOPMENT_CSP : PRODUCTION_CSP
  return {
    name: 'dsh-desktop-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(CSP_META, `$1${csp}$2`)
      },
    },
  }
}

export default defineConfig(({ command }) => ({
  root: rendererRoot,
  base: './',
  plugins: [react(), cspPlugin(command)],
  server: {
    host: '127.0.0.1',
    origin: 'http://127.0.0.1:5173',
    port: 5173,
    strictPort: true,
    allowedHosts: ['127.0.0.1'],
    hmr: {
      host: '127.0.0.1',
      protocol: 'ws',
      port: 5173,
      clientPort: 5173,
    },
  },
  build: {
    outDir: rendererOutput,
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/renderer.js',
        chunkFileNames: 'assets/chunk-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
}))
