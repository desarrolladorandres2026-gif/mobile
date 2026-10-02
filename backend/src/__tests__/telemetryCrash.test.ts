import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { ClientError } from '../models';
import { UserRole } from '../types';
import { sensitiveRateLimiter, crashReportRateLimiter } from '../middlewares';
import { makeUser, authHeader } from './factories';

/**
 * `POST /telemetry/crash`: lo usan el teléfono y, desde el 2026-10-02,
 * Zipp Negocios (`platform: 'windows-desktop'`). Antes compartía el
 * limitador con cambiar contraseña, apagar el 2FA y cerrar todas las
 * sesiones; un bucle de crash podía agotarle a la misma persona el cupo
 * de esas operaciones de verdad sensibles (hallazgo de la auditoría de la
 * Fase 5 del plan de escritorio).
 */
describe('POST /telemetry/crash', () => {
  it('tiene su propio limitador, distinto del de operaciones sensibles', () => {
    expect(crashReportRateLimiter).not.toBe(sensitiveRateLimiter);
  });

  it('acepta un reporte de Zipp Negocios y lo guarda', async () => {
    const user = await makeUser({ role: UserRole.BUSINESS });

    const res = await request(app)
      .post('/api/v1/telemetry/crash')
      .set(await authHeader(user))
      .send({
        message: 'La ventana no respondió',
        platform: 'windows-desktop',
        appVersion: '0.1.0',
        fatal: true,
        at: new Date().toISOString(),
      });

    expect(res.status).toBe(201);
    const stored = await ClientError.findOne({ userId: user._id }).lean();
    expect(stored).toMatchObject({ platform: 'windows-desktop', appVersion: '0.1.0', fatal: true });
  });

  it('exige sesión y valida el cuerpo', async () => {
    const user = await makeUser({ role: UserRole.BUSINESS });

    const noAuth = await request(app).post('/api/v1/telemetry/crash').send({
      message: 'x', platform: 'windows-desktop', appVersion: '0.1.0', at: new Date().toISOString(),
    });
    expect(noAuth.status).toBe(401);

    const badBody = await request(app)
      .post('/api/v1/telemetry/crash')
      .set(await authHeader(user))
      .send({ platform: 'windows-desktop' }); // sin message/appVersion/at
    expect(badBody.status).toBe(400);
  });
});
