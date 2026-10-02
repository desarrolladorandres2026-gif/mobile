import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';

/**
 * `GET /app/version`: la palanca de emergencia de versión mínima. Sin
 * `?app=` responde la del cliente (las builds de antes de separarse en dos
 * apps, todas clientes). `business-desktop` es Zipp Negocios — sin tienda
 * de aplicaciones, lleva `downloadUrl` en vez de `androidUrl`/`iosUrl`.
 */
describe('GET /app/version', () => {
  it('es público, sin sesión', async () => {
    const res = await request(app).get('/api/v1/app/version');
    expect(res.status).toBe(200);
  });

  it('sin ?app= responde la del cliente', async () => {
    const res = await request(app).get('/api/v1/app/version');
    expect(res.body.data.app).toBe('client');
  });

  it('?app=driver y ?app=business-desktop responden sus propias palancas', async () => {
    const driver = await request(app).get('/api/v1/app/version?app=driver');
    expect(driver.body.data.app).toBe('driver');
    expect(driver.body.data).toHaveProperty('androidUrl');

    const desktop = await request(app).get('/api/v1/app/version?app=business-desktop');
    expect(desktop.body.data.app).toBe('business-desktop');
    expect(desktop.body.data).toHaveProperty('downloadUrl');
    expect(desktop.body.data).not.toHaveProperty('androidUrl');
  });

  it('un ?app= desconocido cae al cliente, no revienta', async () => {
    const res = await request(app).get('/api/v1/app/version?app=lo-que-sea');
    expect(res.status).toBe(200);
    expect(res.body.data.app).toBe('client');
  });

  it('sin MIN_BUSINESS_DESKTOP_VERSION configurada, cae a "0.0.0" (nunca bloquea por accidente)', async () => {
    // El valor real se lee una sola vez, al cargar el módulo con el proceso
    // (igual que MIN_APP_VERSION): mutar `process.env` en caliente, aquí,
    // no cambiaría nada. "0.0.0" como default es a propósito — sin la
    // variable puesta, ninguna versión instalada queda nunca por debajo.
    const res = await request(app).get('/api/v1/app/version?app=business-desktop');
    expect(res.body.data.minSupported).toBe('0.0.0');
    expect(res.body.data.downloadUrl).toBeNull();
  });
});
