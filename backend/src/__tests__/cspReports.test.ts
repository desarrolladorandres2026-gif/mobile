import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { CspViolation } from '../models';
import { Permission } from '../security/rbac';
import { normalize, toOrigin, cspReportService } from '../services/cspReport.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeStaff, authHeader } from './factories';

/**
 * M-025 — el receptor de reportes de la CSP de los paneles.
 *
 * Es un endpoint público: lo que importa es que acepte los dos formatos reales de
 * los navegadores, agrupe, no guarde URL completas (pueden llevar ids de pedidos),
 * ignore documentos que no son de ZIPP y nunca responda con un error.
 */

const API = '/api/v1';
const PANEL = 'http://localhost:3001';

const legacy = (over: Record<string, unknown> = {}) => ({
  'csp-report': {
    'document-uri': `${PANEL}/orders/64b7f0f0f0f0f0f0f0f0f0f0?tab=pagos`,
    'violated-directive': 'img-src',
    'effective-directive': 'img-src',
    'blocked-uri': 'https://images.example-cdn.com/foto.png?token=secreto',
    disposition: 'report',
    'source-file': `${PANEL}/assets/index-abc.js`,
    ...over,
  },
});

const modern = (over: Record<string, unknown> = {}) => [
  {
    type: 'csp-violation',
    url: `${PANEL}/zones`,
    body: {
      documentURL: `${PANEL}/zones`,
      effectiveDirective: 'worker-src',
      blockedURL: 'blob',
      disposition: 'report',
      sourceFile: `${PANEL}/assets/vendor.js`,
      sample: 'x'.repeat(200),
      ...over,
    },
  },
];

beforeEach(async () => {
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  await CspViolation.deleteMany({});
});

describe('Normalizar lo que mandan los navegadores', () => {
  it('reduce las URL a su origen: sin ruta, sin ids, sin parámetros', () => {
    expect(toOrigin('https://x.com/a/b?c=1#d')).toBe('https://x.com');
    expect(toOrigin('http://localhost:3001/orders/123')).toBe('http://localhost:3001');
    expect(toOrigin('inline')).toBe('inline');
    expect(toOrigin('data:image/png;base64,AAAA')).toBe('data');
    expect(toOrigin('blob:https://x.com/uuid')).toBe('blob');
    expect(toOrigin('basura')).toBeNull();
    expect(toOrigin(42)).toBeNull();
  });

  it('entiende report-uri', () => {
    const [v] = normalize(legacy());
    expect(v).toMatchObject({
      documentOrigin: PANEL, directive: 'img-src', blocked: 'https://images.example-cdn.com', disposition: 'report', sourceOrigin: PANEL,
    });
    expect(JSON.stringify(v)).not.toContain('secreto');
    expect(JSON.stringify(v)).not.toContain('64b7f0f0');
  });

  it('entiende la Reporting API y recorta la muestra', () => {
    const [v] = normalize(modern());
    expect(v).toMatchObject({ documentOrigin: PANEL, directive: 'worker-src', blocked: 'blob' });
    expect(v.sample!.length).toBeLessThanOrEqual(40);
  });

  it('descarta lo que no encaja y limita cuántos acepta de una vez', () => {
    expect(normalize(null)).toEqual([]);
    expect(normalize({ otra: 'cosa' })).toEqual([]);
    expect(normalize(legacy({ 'effective-directive': 'DROP TABLE;--', 'violated-directive': '$$$' }))).toEqual([]);
    expect(normalize(legacy({ 'effective-directive': 'inventada-src', 'violated-directive': 'inventada-src' }))).toEqual([]);
    expect(normalize(Array.from({ length: 50 }, () => modern()[0]))).toHaveLength(10);
  });

  it('un bloqueo en línea llega con la palabra «inline»', () => {
    expect(normalize(legacy({ 'blocked-uri': '' }))[0].blocked).toBe('inline');
  });
});

describe('POST /csp-report', () => {
  it('acepta application/csp-report sin sesión, responde 204 y agrupa las repetidas', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report').send(JSON.stringify(legacy()));
      expect(res.status).toBe(204);
    }
    const rows = await CspViolation.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 3, directive: 'img-src', blocked: 'https://images.example-cdn.com', documentOrigin: PANEL });
    expect(rows[0].lastSeen.getTime()).toBeGreaterThanOrEqual(rows[0].firstSeen.getTime());
  });

  it('acepta application/reports+json', async () => {
    const res = await request(app).post(`${API}/csp-report`).set('Content-Type', 'application/reports+json').send(JSON.stringify(modern()));
    expect(res.status).toBe(204);
    expect(await CspViolation.countDocuments({ directive: 'worker-src' })).toBe(1);
  });

  it('ignora un documento que no es de un panel de ZIPP: no se llena la tabla con orígenes inventados', async () => {
    const res = await request(app).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report')
      .send(JSON.stringify(legacy({ 'document-uri': 'https://sitio-del-atacante.example/pagina' })));
    expect(res.status).toBe(204);
    expect(await CspViolation.countDocuments({})).toBe(0);
  });

  it('un cuerpo roto, vacío o demasiado grande nunca devuelve un error con detalle', async () => {
    const broken = await request(app).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report').send('{no es json');
    expect([204, 400]).toContain(broken.status);
    expect(JSON.stringify(broken.body)).not.toMatch(/Unexpected token|stack|at /);

    const empty = await request(app).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report').send('');
    expect(empty.status).toBe(204);

    const huge = await request(app).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report').send(JSON.stringify(legacy({ 'script-sample': 'a'.repeat(100_000) })));
    expect([204, 413]).toContain(huge.status);
    expect(await CspViolation.countDocuments({})).toBe(0);
  });

  it('el servicio cuenta lo que guardó', async () => {
    // Un lote mezcla los dos formatos: se cuenta cada infracción reconocible.
    expect(await cspReportService.record([legacy(), modern()[0], { basura: true }])).toBe(2);
    expect(await cspReportService.record(modern())).toBe(1);
  });
});

describe('Lo que cualquiera puede mandar no llena la base', () => {
  it('pasado el tope de grupos, lo conocido sigue contando y lo nuevo no entra', async () => {
    await cspReportService.record(legacy(), new Date(), 1); // primer grupo: entra
    await cspReportService.record(legacy(), new Date(), 1); // mismo grupo: cuenta
    await cspReportService.record(modern(), new Date(), 1); // grupo nuevo con el tope lleno: no entra

    const rows = await CspViolation.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });
});

describe('Leer las infracciones', () => {
  it('con security:view, las más repetidas primero; sin él, no', async () => {
    await cspReportService.record(legacy());
    await cspReportService.record(legacy());
    await cspReportService.record(modern());

    const viewer = await makeStaff({ roleSlug: 'operaciones', permissions: [Permission.SECURITY_VIEW] });
    const outsider = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.SUPPORT_VIEW] });

    const ok = await request(app).get(`${API}/security/csp-violations`).set(await authHeader(viewer));
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((r: any) => r.count)).toEqual([2, 1]);
    expect(ok.body.data[0]).toMatchObject({ directive: 'img-src', blocked: 'https://images.example-cdn.com' });

    expect((await request(app).get(`${API}/security/csp-violations`).set(await authHeader(outsider))).status).toBe(403);
    expect((await request(app).get(`${API}/security/csp-violations`)).status).toBe(401);
  });
});
