import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const vendorChunks: Record<string, string[]> = {
  'vendor-react': ['react', 'react-dom', 'scheduler'],
  'vendor-echarts': ['echarts'],
  'vendor-lightweight-charts': ['lightweight-charts'],
  'vendor-pyodide': ['pyodide'],
  'vendor-docx': ['docx'],
  'vendor-tanstack': ['@tanstack/react-table', '@tanstack/react-virtual'],
}

const deferredEntryPreloadChunks = [
  'vendor-docx',
  'vendor-tanstack',
  'vendor-echarts',
  'vendor-lightweight-charts',
]

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    modulePreload: {
      resolveDependencies(filename, deps, { hostType }) {
        if (hostType !== 'html' || !filename.endsWith('index.html')) return deps
        return deps.filter((dep) => !deferredEntryPreloadChunks.some((chunk) => dep.includes(`${chunk}-`)))
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')
          if (!normalizedId.includes('/node_modules/')) return
          for (const [chunk, packages] of Object.entries(vendorChunks)) {
            if (packages.some((pkg) => normalizedId.includes(`/node_modules/${pkg}/`))) return chunk
          }
        },
      },
    },
  },
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx', 'functions/_shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts'],
    },
  },
})
