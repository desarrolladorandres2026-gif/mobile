import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4100',
    // Chrome instalado en el sistema: no hace falta descargar un navegador aparte.
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1366, height: 820 },
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
  },
  webServer: {
    command: 'node harness.mjs',
    url: 'http://127.0.0.1:4100/healthz',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
