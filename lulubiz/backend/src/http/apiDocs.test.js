import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRANTABLE_SCOPES } from '../auth/apiKeys.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const DOC = fileURLToPath(new URL('../../../docs/API.md', import.meta.url));
const START = '<!-- rutas:inicio -->';
const END = '<!-- rutas:fin -->';
const TENANT = '/v1/tenants/:tenantId';
const PUBLIC = ['/healthz', '/readyz', '/v1/auth/register', '/v1/auth/login', '/v1/auth/mfa/verify', '/v1/auth/verify-email', '/v1/auth/password/forgot', '/v1/auth/password/reset', '/v1/invitations/lookup'];
/** Qué se necesita para llamar una ruta que no es de una empresa. */
const access = (path) => (PUBLIC.includes(path) ? 'pública' : path === '/metrics' ? 'token de métricas' : 'sesión');

const GROUPS = [
  ['Sesión y cuenta (solo con sesión; no admiten claves)', (p) => p.startsWith('/v1/auth') || p === '/v1/me' || p.startsWith('/v1/invitations')],
  ['Estado del servicio', (p) => ['/healthz', '/readyz', '/metrics'].includes(p)],
  ['Plan de cuentas', (p) => p.startsWith('/accounts')],
  ['Centros de costo', (p) => p.startsWith('/cost-centers')],
  ['Conciliación bancaria', (p) => p.startsWith('/bank')],
  ['Activos fijos', (p) => p.startsWith('/fixed-assets')],
  ['Presupuesto', (p) => p.startsWith('/budgets')],
  ['Nómina', (p) => p.startsWith('/payroll')],
  ['Impuestos', (p) => p.startsWith('/taxes')],
  ['Cotizaciones', (p) => p.startsWith('/quotes')],
  ['Órdenes de compra', (p) => p.startsWith('/purchase-orders')],
  ['Facturas recurrentes', (p) => p.startsWith('/recurring-invoices')],
  ['Terceros', (p) => p.startsWith('/parties')],
  ['Asientos y saldos', (p) => p.startsWith('/journals') || p.startsWith('/balances')],
  ['Períodos', (p) => p.startsWith('/periods')],
  ['Cierre de ejercicio', (p) => p.startsWith('/year-end')],
  ['Informes', (p) => p.startsWith('/reports')],
  ['Facturación electrónica', (p) => p.startsWith('/invoic') || p.startsWith('/credit-notes')],
  ['Anticipos', (p) => p.startsWith('/customer-advances') || p.startsWith('/supplier-advances')],
  ['Cartera y recibos de caja', (p) => p.startsWith('/receipt') || p.startsWith('/receivables')],
  ['Compras y pagos', (p) => ['/purchas', '/supplier-notes', '/payments', '/payables'].some((x) => p.startsWith(x))],
  ['Inventario', (p) => ['/items', '/warehouses', '/stock', '/kardex', '/inventory'].some((x) => p.startsWith(x))],
  ['Punto de venta', (p) => p.startsWith('/pos')],
  ['Miembros', (p) => p.startsWith('/members')],
  ['Claves de API', (p) => p.startsWith('/api-keys')],
  ['Auditoría', (p) => p.startsWith('/audit')],
  ['Datos de la empresa', (p) => p.startsWith('/export')],
  ['Primeros pasos', (p) => p.startsWith('/onboarding')],
];

/** Tabla de rutas desde las rutas registradas: la documentación no puede quedarse atrás sin que una prueba lo note. */
function render(routes) {
  const rows = routes.map((r) => {
    const tenant = r.url.startsWith(TENANT);
    const path = tenant ? r.url.slice(TENANT.length) : r.url;
    return { method: r.method, path, display: tenant ? `{tenantId}${path}` : path, permission: tenant ? (r.permission ?? '—') : access(path), tenant };
  });
  const out = [];
  const used = new Set();
  for (const [title, test] of GROUPS) {
    const own = rows.filter((r) => !used.has(r) && test(r.path));
    if (!own.length) continue;
    own.forEach((r) => used.add(r));
    out.push(`### ${title}`, '', '| Método | Ruta | Permiso |', '|---|---|---|');
    for (const r of own) out.push(`| ${r.method} | \`${r.tenant ? `/v1/tenants/{tenantId}${r.path}` : r.path}\` | ${r.tenant && r.permission !== '—' ? `\`${r.permission}\`` : r.permission} |`);
    out.push('');
  }
  const left = rows.filter((r) => !used.has(r));
  if (left.length) throw new Error(`rutas sin grupo en la documentación: ${left.map((r) => `${r.method} ${r.display}`).join(', ')}`);
  return out.join('\n');
}

let mongo;
let app;

beforeAll(async () => {
  mongo = await startMongo('lulubiz_api_docs_test');
  app = await buildApp({ client: mongo.client, db: mongo.db, config: loadConfig({}), reporter: { report: async () => true } });
});

afterAll(async () => {
  await app?.close();
  await mongo?.stop();
});

describe('documentación de la API', () => {
  it('la tabla de rutas de docs/API.md coincide con las rutas registradas y sus permisos', () => {
    const generated = `${START}\n${render(app.routeList)}\n${END}`;
    const current = readFileSync(DOC, 'utf8');
    const block = current.slice(current.indexOf(START), current.indexOf(END) + END.length);
    if (process.env.UPDATE_API_DOCS === '1') {
      writeFileSync(DOC, current.replace(block, () => generated));
      return;
    }
    expect(block, 'docs/API.md desactualizado: corre UPDATE_API_DOCS=1 npx vitest run src/http/apiDocs.test.js').toBe(generated);
  });

  it('toda ruta de empresa declara su permiso', () => {
    const undeclared = app.routeList.filter((r) => r.url.startsWith(TENANT) && !r.permission).map((r) => `${r.method} ${r.url}`);
    // Las únicas rutas de empresa sin permiso propio serían un descuido: una clave o una sesión sin permiso no debería pasar.
    expect(undeclared).toEqual([]);
  });

  it('cada permiso que se puede dar a una clave protege alguna ruta, y cada ruta usa un permiso que existe', () => {
    const used = new Set(app.routeList.map((r) => r.permission).filter(Boolean));
    for (const scope of GRANTABLE_SCOPES) expect(used.has(scope), `el permiso ${scope} no protege ninguna ruta`).toBe(true);
    for (const permission of used) expect(PERMISSIONS, `permiso desconocido ${permission}`).toContain(permission);
  });
});
