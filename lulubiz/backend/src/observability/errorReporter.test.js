import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { combineReporters, createLogReporter, createWebhookReporter, installProcessHandlers } from './errorReporter.js';

let server;
let url;
let received;
let respondWith = 200;

beforeAll(async () => {
  received = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.statusCode = respondWith;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/errores`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('reportero por webhook', () => {
  it('envía el error por POST JSON con servicio, entorno, pila y contexto', async () => {
    received.length = 0;
    respondWith = 200;
    const reporter = createWebhookReporter({ url, service: 'lulubiz-api', environment: 'prueba' });
    const ok = await reporter.report(new TypeError('algo falló'), { requestId: 'r-1', route: '/v1/x', status: 500 });
    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].body).toMatchObject({
      service: 'lulubiz-api',
      environment: 'prueba',
      name: 'TypeError',
      message: 'algo falló',
      context: { requestId: 'r-1', route: '/v1/x', status: '500' },
    });
    expect(received[0].body.stack).toContain('TypeError');
  });

  it('nunca envía campos fuera de la lista segura (cookies, cabeceras, cuerpos)', async () => {
    received.length = 0;
    const reporter = createWebhookReporter({ url });
    await reporter.report(new Error('x'), {
      requestId: 'r-2',
      cookie: 'lulubiz_session=SECRETO',
      authorization: 'Bearer SECRETO',
      body: { password: 'SECRETO' },
    });
    expect(JSON.stringify(received[0].body)).not.toContain('SECRETO');
    expect(Object.keys(received[0].body.context)).toEqual(['requestId']);
  });

  it('limita los envíos por minuto, cuenta los descartados y reanuda en la ventana siguiente', async () => {
    received.length = 0;
    let t = 1_000_000;
    const reporter = createWebhookReporter({ url, maxPerMinute: 2, now: () => t });
    expect(await reporter.report(new Error('1'))).toBe(true);
    expect(await reporter.report(new Error('2'))).toBe(true);
    expect(await reporter.report(new Error('3'))).toBe(false);
    expect(await reporter.report(new Error('4'))).toBe(false);
    expect(reporter.dropped).toBe(2);
    expect(received).toHaveLength(2);
    t += 60_000;
    expect(await reporter.report(new Error('5'))).toBe(true);
    expect(received).toHaveLength(3);
  });

  it('un destino que responde error o no responde no lanza ni cuelga', async () => {
    respondWith = 500;
    expect(await createWebhookReporter({ url }).report(new Error('x'))).toBe(false);
    respondWith = 200;
    const closedPort = createWebhookReporter({ url: 'http://127.0.0.1:1/', timeoutMs: 500 });
    await expect(closedPort.report(new Error('x'))).resolves.toBe(false);
  });

  it('exige la URL', () => {
    expect(() => createWebhookReporter({})).toThrow(/URL/);
  });
});

describe('combinación y captura de procesos', () => {
  it('un destino que falla no impide que lleguen los demás', async () => {
    const good = { report: vi.fn(async () => true) };
    const bad = { report: vi.fn(async () => { throw new Error('caído'); }) };
    const result = await combineReporters(bad, good).report(new Error('x'), {});
    expect(result).toBe(true);
    expect(good.report).toHaveBeenCalledOnce();
    expect(bad.report).toHaveBeenCalledOnce();
  });

  it('el reportero de log escribe el error con su contexto seguro', async () => {
    const log = { error: vi.fn() };
    await createLogReporter(log).report(new Error('x'), { requestId: 'r-3', cookie: 'SECRETO' });
    const [fields] = log.error.mock.calls[0];
    expect(fields.requestId).toBe('r-3');
    expect(JSON.stringify(Object.keys(fields))).not.toContain('cookie');
  });

  it('una promesa rechazada se reporta sin terminar el proceso', async () => {
    const target = new EventEmitter();
    const reporter = { report: vi.fn(async () => true) };
    const exit = vi.fn();
    installProcessHandlers({ reporter, log: { error: vi.fn(), fatal: vi.fn() }, exit, target });
    target.emit('unhandledRejection', 'motivo suelto');
    expect(reporter.report).toHaveBeenCalledOnce();
    expect(reporter.report.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(reporter.report.mock.calls[0][0].message).toBe('motivo suelto');
    expect(exit).not.toHaveBeenCalled();
  });

  it('una excepción sin atrapar se reporta y termina el proceso con código 1', async () => {
    const target = new EventEmitter();
    const reporter = { report: vi.fn(async () => true) };
    const exit = vi.fn();
    installProcessHandlers({ reporter, log: { error: vi.fn(), fatal: vi.fn() }, exit, target, flushMs: 50 });
    target.emit('uncaughtException', new Error('grave'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(reporter.report).toHaveBeenCalledOnce();
  });

  it('si el destino se cuelga, el proceso igual termina tras el plazo', async () => {
    const target = new EventEmitter();
    const reporter = { report: () => new Promise(() => {}) };
    const exit = vi.fn();
    installProcessHandlers({ reporter, log: { error: vi.fn(), fatal: vi.fn() }, exit, target, flushMs: 50 });
    target.emit('uncaughtException', new Error('grave'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 2000 });
  });
});
