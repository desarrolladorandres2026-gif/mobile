import { describe, expect, it, vi } from 'vitest';
import { BusyError } from '../core/limiter.js';
import { errorHandler } from './errors.js';

function run(err) {
  const reply = { headers: {}, header(name, value) { this.headers[name] = value; return this; }, status(code) { this.code = code; return this; }, send(body) { this.body = body; return this; } };
  const report = vi.fn(async () => true);
  const request = { id: 'r1', method: 'GET', routeOptions: { url: '/x' }, ctx: undefined, log: { error: vi.fn() }, server: { reporter: { report } } };
  errorHandler(err, request, reply);
  return { reply, report, request };
}

describe('manejador de errores', () => {
  it('un fallo inesperado es 500 genérico, se registra y se reporta, sin filtrar el detalle', () => {
    const { reply, report, request } = run(new Error('detalle interno secreto'));
    expect(reply.code).toBe(500);
    expect(reply.body).toEqual({ error: 'INTERNAL', message: 'error interno' });
    expect(JSON.stringify(reply.body)).not.toContain('secreto');
    expect(report).toHaveBeenCalledOnce();
    expect(request.log.error).toHaveBeenCalled();
  });

  it('el servicio ocupado es 503 con Retry-After, con su mensaje, y no se reporta como fallo', () => {
    const { reply, report } = run(new BusyError('demasiadas operaciones en espera para esta empresa'));
    expect(reply.code).toBe(503);
    expect(reply.headers['retry-after']).toBe('2');
    expect(reply.body).toMatchObject({ error: 'BusyError', message: expect.stringMatching(/demasiadas operaciones/) });
    expect(report).not.toHaveBeenCalled();
  });

  it('«no configurado» es 501 con su mensaje y no se reporta', () => {
    const { reply, report } = run(Object.assign(new Error('la facturación electrónica no está configurada'), { code: 'NOT_CONFIGURED' }));
    expect(reply.code).toBe(501);
    expect(reply.body.error).toBe('NOT_CONFIGURED');
    expect(report).not.toHaveBeenCalled();
  });

  it('los errores de dominio conservan su código HTTP', () => {
    expect(run(Object.assign(new Error('x'), { code: 'FORBIDDEN' })).reply.code).toBe(403);
    expect(run(Object.assign(new Error('x'), { code: 'OVER_CREDIT' })).reply.code).toBe(409);
    expect(run(Object.assign(new Error('x'), { name: 'PeriodClosedError' })).reply.code).toBe(409);
  });
});
