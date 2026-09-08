import { defineConfig } from 'vitest/config';

/**
 * Configuración aparte para la prueba de carga.
 *
 * Vive fuera de `vitest.config.ts` a propósito. La suite normal tarda unos
 * seis minutos y se corre después de cada cambio; ésta monta siete mil
 * usuarios y lanza miles de operaciones simultáneas, así que meterla en el
 * `include` de siempre convertiría cada verificación rutinaria en una
 * espera larga — y una prueba que molesta acaba desactivada.
 *
 * Se corre a mano: `npm run test:load`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.load.ts'],
    setupFiles: ['src/__tests__/load/setup.ts'],
    env: { NODE_ENV: 'test' },
    fileParallelism: false,
    // Las fases largas —crear miles de pedidos, repartirlos, entregarlos—
    // llevan minutos por diseño. Cada `it` declara además el suyo.
    testTimeout: 900_000,
    hookTimeout: 900_000,
    // Sin aislamiento entre pruebas: el estado se acumula a propósito.
    // Ver `src/__tests__/load/setup.ts`.
    sequence: { shuffle: false },
  },
});
