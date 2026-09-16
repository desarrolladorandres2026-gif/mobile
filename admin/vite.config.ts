import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Escribe /version.json en cada build de producción con un id nuevo
 * (timestamp del build). El cliente lo compara contra el que cargó la
 * pestaña para detectar solo un deploy más reciente — ver
 * src/lib/checkForUpdates.ts. `generateBundle` no corre en `vite dev`, así
 * que el archivo no existe en desarrollo (el hook lo tiene en cuenta).
 */
function versionFile(): Plugin {
  return {
    name: 'zipp-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId: String(Date.now()) }),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), versionFile()],
  server: {
    port: 3001,
  },
})
