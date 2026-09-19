import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Las librerías que no cambian entre despliegues van en su propio archivo.
 *
 * Sin esto, React y el router se empaquetaban junto al código de la app, y
 * cualquier cambio de una línea en una página invalidaba también esos
 * ~60 KB comprimidos: el navegador los volvía a descargar en cada deploy
 * aunque tuviera un año de caché. Solo se nombran las que carga el arranque;
 * un grupo genérico de `node_modules` arrastraría al archivo inicial también
 * lo que hoy se carga bajo demanda (Leaflet, mapbox-gl).
 */
const vendorChunks = {
  groups: [
    {
      name: 'vendor-react',
      test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
    },
    {
      name: 'vendor-data',
      test: /[\\/]node_modules[\\/](@tanstack|axios|zustand)[\\/]/,
    },
  ],
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: { codeSplitting: vendorChunks },
    },
  },
  server: {
    port: 3003,
  },
})
