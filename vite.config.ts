import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const vendorChunks: Record<string, string[]> = {
  'vendor-echarts': ['echarts'],
  'vendor-lightweight-charts': ['lightweight-charts'],
  'vendor-pyodide': ['pyodide'],
  'vendor-docx': ['docx'],
  'vendor-tanstack': ['@tanstack/react-table', '@tanstack/react-virtual'],
}

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [chunk, packages] of Object.entries(vendorChunks)) {
            if (packages.some((pkg) => id.includes(pkg))) return chunk
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
