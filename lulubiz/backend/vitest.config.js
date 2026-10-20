import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60_000,
    // La primera ejecución descarga el binario de MongoDB para las pruebas.
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
