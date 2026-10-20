import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100,
    // Mismo origen para el navegador: la cookie de sesión es SameSite=Strict y no hace falta CORS.
    proxy: { '/v1': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: false,
    css: false,
  },
});
