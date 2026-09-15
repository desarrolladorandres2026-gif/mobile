import { defineConfig } from 'vitest/config';

// Solo lógica pura (`src/lib`): el panel no monta componentes en pruebas.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
