import { MongoClient } from 'mongodb';
import { computeNitCheckDigit } from '../countries/co/taxId.js';
import { ensureIndexes } from '../data/db.js';
import { buildApp } from '../http/app.js';
import { loadConfig } from '../http/config.js';
import { createMemoryMailer } from '../mail/mailer.js';

/*
 * Llena una empresa de demostración con datos de prueba en todos los módulos, usando la API real:
 * así el libro, los saldos, el inventario y la auditoría quedan tan coherentes como si alguien los hubiera tecleado.
 *
 * Uso: npm run seed:demo [correo] [contraseña]      (con --memory prueba en una base temporal y no toca nada)
 * Se niega a correr en producción. Crea siempre una empresa nueva: si el correo ya existe, se detiene.
 */

export const DEMO_PASSWORD = 'correcto-caballo-grapa-2026';
export const DEMO_EMAIL = 'demo@lulubiz.test';

const cop = (pesos) => Math.round(pesos * 100);
const qty = (units) => Math.round(units * 1000);

/** Generador pseudoaleatorio con semilla: cada corrida produce los mismos datos. */
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------- catálogos

const ACCOUNTS = [
  // [código, nombre, tipo, grupo]
  ['110505', 'Caja general', 'asset', '11'],
  ['111005', 'Bancos - Bancolombia cuenta corriente', 'asset', '11'],
  ['112005', 'Datáfono por cobrar', 'asset', '11'],
  ['130505', 'Clientes nacionales', 'asset', '13'],
  ['133005', 'Anticipos a proveedores', 'asset', '13'],
  ['135515', 'Retención en la fuente a favor', 'asset', '13'],
  ['135520', 'Saldo a favor de IVA', 'asset', '13'],
  ['143505', 'Mercancías no fabricadas por la empresa', 'asset', '14'],
  ['152405', 'Equipo de oficina', 'asset', '15'],
  ['152805', 'Equipo de computación', 'asset', '15'],
  ['159205', 'Depreciación acumulada de equipo de oficina', 'asset', '15'],
  ['159210', 'Depreciación acumulada de equipo de computación', 'asset', '15'],
  ['220505', 'Proveedores nacionales', 'liability', '22'],
  ['236505', 'Retención en la fuente por salarios', 'liability', '23'],
  ['236540', 'Retención en la fuente por compras', 'liability', '23'],
  ['237005', 'Aportes a EPS', 'liability', '23'],
  ['237006', 'Aportes a ARL', 'liability', '23'],
  ['237010', 'Aportes a cajas de compensación', 'liability', '23'],
  ['237015', 'Aportes al SENA', 'liability', '23'],
  ['237020', 'Aportes al ICBF', 'liability', '23'],
  ['237095', 'Otras deducciones de nómina', 'liability', '23'],
  ['238030', 'Fondos de pensiones', 'liability', '23'],
  ['240805', 'IVA generado por pagar', 'liability', '24'],
  ['240810', 'IVA descontable', 'liability', '24'],
  ['240815', 'IVA por pagar a la DIAN', 'liability', '24'],
  ['250505', 'Salarios por pagar', 'liability', '25'],
  ['261005', 'Cesantías consolidadas', 'liability', '26'],
  ['261010', 'Intereses sobre cesantías', 'liability', '26'],
  ['261015', 'Vacaciones consolidadas', 'liability', '26'],
  ['261020', 'Prima de servicios', 'liability', '26'],
  ['280505', 'Anticipos y avances recibidos de clientes', 'liability', '28'],
  ['310505', 'Capital autorizado', 'equity', '31'],
  ['413505', 'Venta de mercancías', 'income', '41'],
  ['414505', 'Prestación de servicios', 'income', '41'],
  ['421005', 'Rendimientos financieros', 'income', '42'],
  ['429581', 'Utilidad en venta de activos', 'income', '42'],
  ['429595', 'Sobrantes de caja', 'income', '42'],
  ['510506', 'Sueldos', 'expense', '51'],
  ['510527', 'Auxilio de transporte', 'expense', '51'],
  ['510530', 'Cesantías', 'expense', '51'],
  ['510533', 'Intereses sobre cesantías', 'expense', '51'],
  ['510536', 'Prima de servicios', 'expense', '51'],
  ['510539', 'Vacaciones', 'expense', '51'],
  ['510548', 'Bonificaciones', 'expense', '51'],
  ['510568', 'Aportes a ARL', 'expense', '51'],
  ['510569', 'Aportes a EPS', 'expense', '51'],
  ['510570', 'Aportes a fondos de pensiones', 'expense', '51'],
  ['510572', 'Aportes a cajas de compensación', 'expense', '51'],
  ['510575', 'Aportes al ICBF', 'expense', '51'],
  ['510578', 'Aportes al SENA', 'expense', '51'],
  ['512010', 'Arrendamientos', 'expense', '51'],
  ['513525', 'Servicios públicos', 'expense', '51'],
  ['516005', 'Depreciación de equipo de oficina', 'expense', '51'],
  ['516010', 'Depreciación de equipo de computación', 'expense', '51'],
  ['519595', 'Gastos diversos', 'expense', '51'],
  ['523505', 'Publicidad y propaganda', 'expense', '52'],
  ['529595', 'Pérdida de inventario', 'expense', '52'],
  ['530505', 'Gastos bancarios', 'expense', '53'],
  ['530595', 'Faltantes de caja', 'expense', '53'],
  ['539595', 'Pérdida en venta de activos', 'expense', '53'],
  ['613505', 'Costo de mercancía vendida', 'cost', '61'],
];

const PAYROLL_ACCOUNTS = {
  salaryExpense: '510506', nonSalaryExpense: '510548', transportExpense: '510527', employerHealthExpense: '510569', employerPensionExpense: '510570',
  arlExpense: '510568', cajaExpense: '510572', senaExpense: '510578', icbfExpense: '510575', cesantiasExpense: '510530', cesantiasInterestExpense: '510533',
  primaExpense: '510536', vacationsExpense: '510539', payrollPayable: '250505', healthPayable: '237005', pensionPayable: '238030', arlPayable: '237006',
  cajaPayable: '237010', senaPayable: '237015', icbfPayable: '237020', withholdingPayable: '236505', deductionsPayable: '237095', cesantiasPayable: '261005',
  cesantiasInterestPayable: '261010', primaPayable: '261020', vacationsPayable: '261015',
};

const COST_CENTERS = [['ADM', 'Administración'], ['VEN', 'Ventas y mostrador'], ['BOD', 'Bodega y logística'], ['GAR', 'Sucursal Garzón']];

const nit = (base, extra) => ({ taxIdType: 'NIT', taxId: String(base), checkDigit: computeNitCheckDigit(base), ...extra });
const cc = (id, extra) => ({ taxIdType: 'CC', taxId: String(id), ...extra });
const addr = (line, city = 'Garzón', region = 'Huila') => ({ line, city, region, country: 'CO' });

const CUSTOMERS = [
  { name: 'Supermercado La Economía SAS', ...nit(900451237), email: 'compras@laeconomia.example', phone: '3101234567', address: addr('Carrera 10 # 8-35') },
  { name: 'Tienda Doña Rosa', ...cc(36151234), email: 'rosa.tienda@example.com', phone: '3112345678', address: addr('Calle 7 # 12-20') },
  { name: 'Restaurante El Fogón del Huila SAS', ...nit(901233876), email: 'admon@elfogon.example', phone: '3123456789', address: addr('Carrera 9 # 5-40', 'Pitalito') },
  { name: 'Hotel Casa Real SAS', ...nit(900877214), email: 'contabilidad@casareal.example', phone: '3134567890', address: addr('Calle 6 # 9-12') },
  { name: 'Panadería La Espiga', ...cc(12234567), email: 'laespiga@example.com', phone: '3145678901', address: addr('Carrera 11 # 4-18', 'Gigante') },
  { name: 'Cooperativa de Caficultores del Sur', ...nit(891100678), email: 'tesoreria@cafisur.example', phone: '3156789012', address: addr('Avenida 8 # 15-60', 'La Plata') },
  { name: 'Colegio San Agustín', ...nit(891180079), email: 'rectoria@sanagustin.example', phone: '3167890123', address: addr('Calle 4 # 6-31') },
  { name: 'Minimercado El Ahorro', ...cc(7712345), email: 'elahorro@example.com', phone: '3178901234', address: addr('Carrera 12 # 10-05', 'Altamira') },
];

const SUPPLIERS = [
  { name: 'Alimentos del Valle SAS', ...nit(800197268), email: 'ventas@alimentosvalle.example', phone: '6024445566', address: addr('Zona Industrial Acopi', 'Yumbo', 'Valle del Cauca') },
  { name: 'Distribuciones Surandina SAS', ...nit(900345612), email: 'pedidos@surandina.example', phone: '6088712345', address: addr('Carrera 5 # 20-10', 'Neiva') },
  { name: 'Aseo y Hogar de Colombia SAS', ...nit(860512330), email: 'comercial@aseohogar.example', phone: '6017654321', address: addr('Calle 13 # 68-20', 'Bogotá', 'Cundinamarca') },
  { name: 'Bebidas del Huila Ltda', ...nit(891180268), email: 'despachos@bebidashuila.example', phone: '6088623344', address: addr('Calle 21 # 6-50', 'Neiva') },
  { name: 'Inmobiliaria Garzón SAS', ...nit(900612345), email: 'cartera@inmogarzon.example', phone: '6088332211', address: addr('Carrera 10 # 6-12') },
  { name: 'Electrificadora del Huila SA ESP', ...nit(800153217), email: 'facturacion@electrohuila.example', phone: '6088664040', address: addr('Carrera 1 # 20-30', 'Neiva') },
  { name: 'Papelería El Estudiante', roles: ['customer', 'supplier'], ...cc(55123456), email: 'elestudiante@example.com', phone: '3189012345', address: addr('Calle 5 # 8-14') },
];

// [sku, nombre, unidad, costo, precio, iva en pb, existencia mínima (unidades)]
const GOODS = [
  ['ARR500', 'Arroz blanco 500 g', 'UND', 2100, 2900, 0, 200],
  ['ACE1L', 'Aceite vegetal 1 L', 'UND', 9800, 12900, 1900, 60],
  ['AZU1K', 'Azúcar refinada 1 kg', 'UND', 3900, 5200, 0, 150],
  ['CAF250', 'Café molido 250 g', 'UND', 6800, 9500, 500, 80],
  ['LEC1L', 'Leche entera larga vida 1 L', 'UND', 3300, 4400, 0, 200],
  ['DET2K', 'Detergente en polvo 2 kg', 'UND', 14200, 18900, 1900, 40],
  ['JAB3', 'Jabón de tocador x3', 'UND', 5100, 7200, 1900, 60],
  ['PAP12', 'Papel higiénico x12', 'UND', 17500, 23900, 1900, 40],
  ['GAS350', 'Gaseosa 350 ml caja x24', 'CAJ', 28000, 36500, 1900, 30],
  ['AGU600', 'Agua 600 ml caja x12', 'CAJ', 9600, 13200, 1900, 25],
  ['HUE30', 'Huevos AA cubeta x30', 'CUB', 15500, 19800, 0, 30],
];
const SERVICES = [
  ['DOMIC', 'Servicio de domicilio', 'UND', 8000, 1900],
  ['EXHIB', 'Montaje y exhibición en punto de venta', 'UND', 150000, 1900],
];

// ---------------------------------------------------------------------------------------------- ejecución

export async function seedDemo({ client, db, config, email = DEMO_EMAIL, password = DEMO_PASSWORD, today = new Date(), log = console.log }) {
  const mailer = createMemoryMailer();
  const cfg = { ...config, rateLimit: Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 100_000 }])) };
  const app = await buildApp({ client, db, config: cfg, mailer, reporter: { report: async () => true } });
  const rand = prng(20261023);
  const run = Date.now().toString(36);
  let seq = 0;
  const failures = [];

  const dayMs = 86_400_000;
  const iso = (daysAgo) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - daysAgo * dayMs).toISOString().slice(0, 10);
  const year = today.getUTCFullYear();
  const ym = (monthsBack) => {
    const d = new Date(Date.UTC(year, today.getUTCMonth() - monthsBack, 1));
    return d.toISOString().slice(0, 7);
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (min, max) => min + Math.floor(rand() * (max - min + 1));

  let cookie = '';
  let base = '';
  const request = async (method, path, body, { key = false, expect } = {}) => {
    const res = await app.inject({
      method,
      url: path.startsWith('/v1') ? path : `${base}${path}`,
      headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': `seed-${run}-${(seq += 1)}` } : {}) },
      ...(body !== undefined ? { payload: body } : {}),
    });
    if (res.statusCode >= 400 && res.statusCode !== expect) throw new Error(`${method} ${path} → ${res.statusCode} ${res.body.slice(0, 300)}`);
    return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null, cookies: res.cookies };
  };
  const api = async (...args) => (await request(...args)).data;

  /** Un paso que puede fallar sin tumbar el resto: se anota y se sigue. */
  const step = async (name, fn) => {
    try {
      const out = await fn();
      log(`  ✓ ${name}`);
      return out;
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      log(`  ✗ ${name}\n      ${err.message}`);
      return undefined;
    }
  };

  const journal = (date, description, lines) =>
    api('POST', '/journals', { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', description, lines }, { key: true });

  // ------------------------------------------------------------------ empresa, usuario y plan de cuentas
  log('Empresa y plan de cuentas');
  const reg = await request('POST', '/v1/auth/register', {
    companyName: 'Distribuidora Andina del Huila SAS', country: 'CO', currency: 'COP', ownerName: 'Laura Gómez', email, password,
  }, { expect: 409 });
  if (reg.status === 409) throw new Error(`el correo ${email} ya existe: usa otro (npm run seed:demo otro@correo.test)`);
  base = `/v1/tenants/${reg.data.tenantId}`;
  await db.collection('users').updateOne({ email: email.toLowerCase() }, { $set: { emailVerifiedAt: new Date() } });
  const login = await request('POST', '/v1/auth/login', { email, password });
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;

  await step('plan de cuentas (clases y grupos del PUC)', () => api('POST', '/accounts/seed'));
  await step(`${ACCOUNTS.length} cuentas auxiliares`, async () => {
    for (const [code, name, type, parentCode] of ACCOUNTS) await api('POST', '/accounts', { code, name, type, parentCode });
  });
  await step('centros de costo', async () => {
    for (const [code, name] of COST_CENTERS) await api('POST', '/cost-centers', { code, name });
    await api('POST', '/cost-centers', { code: 'OLD', name: 'Sucursal Neiva (cerrada)' });
    await api('PATCH', '/cost-centers/OLD', { active: false });
  });
  await step('cuenta desactivada de ejemplo', async () => {
    await api('POST', '/accounts', { code: '519505', name: 'Gastos de viaje (en desuso)', type: 'expense', parentCode: '51' });
    await api('POST', '/accounts/519505/deactivate');
  });

  // ------------------------------------------------------------------ facturación electrónica
  log('Facturación');
  await step('datos del emisor y cuentas', () =>
    api('PUT', '/invoicing/settings', {
      issuer: { name: 'Distribuidora Andina del Huila SAS', taxIdType: 'NIT', taxId: '901234567', checkDigit: computeNitCheckDigit(901234567), regime: 'responsable_iva', email: 'facturacion@andinahuila.example', phone: '6088331122', address: { line: 'Carrera 9 # 7-45', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', cash: '110505', payable: '220505', vatDeductible: '240810', customerAdvance: '280505', supplierAdvance: '133005' },
    }),
  );
  await step('resoluciones de numeración', async () => {
    await api('POST', '/invoicing/resolutions', { docType: 'invoice', prefix: 'FE', number: '18764098765432', from: 1, to: 5000, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31` });
    await api('POST', '/invoicing/resolutions', { docType: 'credit_note', prefix: 'NC', number: '18764098765499', from: 1, to: 500, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31` });
    await api('POST', '/invoicing/resolutions', { docType: 'invoice', prefix: 'OLD', number: '18764011111111', from: 1, to: 100, validFrom: `${year - 1}-01-01`, validTo: `${year - 1}-12-31` });
  });

  // ------------------------------------------------------------------ terceros
  log('Terceros');
  const customers = [];
  const suppliers = [];
  await step(`${CUSTOMERS.length} clientes y ${SUPPLIERS.length} proveedores`, async () => {
    for (const c of CUSTOMERS) customers.push(await api('POST', '/parties', { roles: ['customer'], ...c }));
    for (const s of SUPPLIERS) suppliers.push(await api('POST', '/parties', { roles: ['supplier'], ...s }));
    const inactive = await api('POST', '/parties', { name: 'Ferretería Antigua (inactiva)', roles: ['supplier'], ...cc(19876543) });
    await api('POST', `/parties/${inactive._id}/active`, { active: false });
    await api('PATCH', `/parties/${customers[1]._id}`, { phone: '3112345999' });
  });
  const supplier = (name) => suppliers.find((s) => s.name.startsWith(name));
  const customer = (name) => customers.find((c) => c.name.startsWith(name));

  // ------------------------------------------------------------------ inventario
  log('Inventario');
  const items = {};
  let whMain;
  let whShop;
  await step('bodegas', async () => {
    const existing = (await api('GET', '/warehouses')).items;
    await api('POST', '/warehouses', { code: 'PRIN', name: 'Bodega principal Garzón' }).catch(() => {});
    await api('POST', '/warehouses', { code: 'TIEND', name: 'Tienda de mostrador' });
    await api('POST', '/warehouses', { code: 'VIEJA', name: 'Bodega anterior (cerrada)' });
    const all = (await api('GET', '/warehouses')).items;
    const vieja = all.find((w) => w.code === 'VIEJA');
    await api('POST', `/warehouses/${vieja._id}/active`, { active: false });
    whMain = all.find((w) => w.code === 'PRIN') ?? existing[0];
    whShop = all.find((w) => w.code === 'TIEND');
  });
  await step(`${GOODS.length} artículos y ${SERVICES.length} servicios`, async () => {
    for (const [sku, name, unit, , price, vatBps, minUnits] of GOODS) {
      items[sku] = await api('POST', '/items', { sku, name, type: 'goods', unit, inventoryAccount: '143505', cogsAccount: '613505', price: cop(price), vatBps, minStock: qty(minUnits) });
    }
    for (const [sku, name, unit, price, vatBps] of SERVICES) {
      items[sku] = await api('POST', '/items', { sku, name, type: 'service', unit, incomeAccount: '414505', price: cop(price), vatBps });
    }
  });
  const costOf = (sku) => GOODS.find((g) => g[0] === sku)[3];
  const priceOf = (sku) => GOODS.find((g) => g[0] === sku)[4];
  const vatOf = (sku) => GOODS.find((g) => g[0] === sku)[5];

  // ------------------------------------------------------------------ capital y activos
  log('Capital y activos fijos');
  await step('aporte de capital inicial', () =>
    journal(`${year}-01-02`, 'Aporte inicial de capital de los socios', [
      { accountId: '111005', debit: cop(420_000_000), description: 'Consignación de socios' },
      { accountId: '110505', debit: cop(15_000_000), description: 'Efectivo para caja general' },
      { accountId: '310505', credit: cop(435_000_000) },
    ]),
  );
  const assetDefs = [
    { code: 'EQ-001', name: 'Computador portátil gerencia', date: `${year}-02-10`, cost: 4_200_000, life: 36, accounts: { asset: '152805', accumulated: '159210', expense: '516010' }, costCenter: 'ADM' },
    { code: 'EQ-002', name: 'Impresora multifuncional', date: `${year}-01-20`, cost: 1_100_000, life: 24, accounts: { asset: '152805', accumulated: '159210', expense: '516010' }, costCenter: 'ADM' },
    { code: 'MO-001', name: 'Vitrina refrigerada de tienda', date: `${year}-03-05`, cost: 9_800_000, life: 60, salvage: 800_000, accounts: { asset: '152405', accumulated: '159205', expense: '516005' }, costCenter: 'GAR' },
    { code: 'MO-002', name: 'Estantería metálica de bodega', date: `${year}-03-18`, cost: 6_500_000, life: 120, salvage: 500_000, accounts: { asset: '152405', accumulated: '159205', expense: '516005' }, costCenter: 'BOD' },
  ];
  const assets = [];
  await step(`${assetDefs.length} activos fijos (compra, alta y depreciación mensual)`, async () => {
    for (const a of assetDefs) {
      await journal(a.date, `Compra de activo fijo ${a.code}`, [{ accountId: a.accounts.asset, debit: cop(a.cost), costCenter: a.costCenter }, { accountId: '111005', credit: cop(a.cost) }]);
      assets.push(await api('POST', '/fixed-assets', {
        code: a.code, name: a.name, acquisitionDate: a.date, cost: cop(a.cost), salvageValue: cop(a.salvage ?? 0), usefulLifeMonths: a.life, accounts: a.accounts, costCenter: a.costCenter,
        description: 'Activo de demostración con depreciación en línea recta',
      }));
    }
    for (let m = 1; m <= today.getUTCMonth() + 1; m += 1) await api('POST', '/fixed-assets/depreciation', { period: `${year}-${String(m).padStart(2, '0')}` });
  });
  await step('baja de un activo con utilidad', () =>
    api('POST', `/fixed-assets/${assets[1]._id}/dispose`, { date: iso(15), proceeds: cop(450_000), proceedsAccount: '110505', gainAccount: '429581', lossAccount: '539595' }),
  );

  // ------------------------------------------------------------------ compras
  log('Compras y pagos a proveedores');
  const purchases = [];
  const lineOf = (sku, units, warehouseId) => ({
    description: items[sku].name, quantity: qty(units), unitPrice: cop(costOf(sku)), vatBps: vatOf(sku), itemId: items[sku]._id, warehouseId,
  });
  const withhold = [{ name: 'Retefuente compras 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250 }];
  await step('facturas de compra de mercancía', async () => {
    const defs = [
      [140, 'Alimentos del Valle', 'FV-8841', 30, [['ARR500', 900], ['AZU1K', 700], ['LEC1L', 1100], ['HUE30', 160], ['CAF250', 420]], true],
      [135, 'Aseo y Hogar', 'AH-20331', 45, [['DET2K', 260], ['JAB3', 520], ['PAP12', 200]], true],
      [130, 'Bebidas del Huila', 'BH-5520', 15, [['GAS350', 190], ['AGU600', 150]], false],
      [120, 'Distribuciones Surandina', 'DS-9012', 30, [['ACE1L', 380], ['ARR500', 500], ['AZU1K', 380]], true],
      [60, 'Alimentos del Valle', 'FV-9210', 30, [['ARR500', 600], ['LEC1L', 700], ['HUE30', 120], ['CAF250', 260]], true],
      [45, 'Aseo y Hogar', 'AH-20877', 30, [['DET2K', 160], ['PAP12', 130], ['JAB3', 220]], false],
      [30, 'Bebidas del Huila', 'BH-5788', 15, [['GAS350', 120], ['AGU600', 90]], false],
      [12, 'Distribuciones Surandina', 'DS-9650', 30, [['ACE1L', 200], ['AZU1K', 250]], false],
    ];
    for (const [ago, who, doc, dueDays, lines, retefuente] of defs) {
      const out = await api('POST', '/purchases', {
        supplierId: supplier(who)._id, supplierDocNumber: doc, issueDate: iso(ago), dueDate: iso(ago - dueDays),
        notes: 'Reposición de inventario', lines: lines.map(([sku, u]) => lineOf(sku, u, whMain._id)), ...(retefuente ? { withholdings: withhold } : {}),
      }, { key: true });
      purchases.push({ ...out.purchase, ago, who });
    }
  });
  await step('facturas de arrendamiento y servicios públicos', async () => {
    for (let k = 0; k < 3; k += 1) {
      const ago = 75 - k * 30;
      const rent = await api('POST', '/purchases', {
        supplierId: supplier('Inmobiliaria')._id, supplierDocNumber: `ARR-${100 + k}`, issueDate: iso(ago), dueDate: iso(ago - 5),
        lines: [{ description: `Arrendamiento local y bodega, mes ${k + 1}`, quantity: qty(1), unitPrice: cop(4_500_000), vatBps: 0, accountId: '512010', costCenter: 'ADM' }],
        withholdings: [{ name: 'Retefuente arrendamientos 3,5 %', accountId: '236540', basis: 'subtotal', rateBps: 350 }],
      }, { key: true });
      purchases.push({ ...rent.purchase, ago, who: 'Inmobiliaria' });
      const power = await api('POST', '/purchases', {
        supplierId: supplier('Electrificadora')._id, supplierDocNumber: `EH-${7700 + k}`, issueDate: iso(ago - 3), dueDate: iso(ago - 13),
        lines: [{ description: 'Consumo de energía eléctrica', quantity: qty(1), unitPrice: cop(between(520_000, 780_000)), vatBps: 0, accountId: '513525', costCenter: 'GAR' }],
      }, { key: true });
      purchases.push({ ...power.purchase, ago: ago - 3, who: 'Electrificadora' });
    }
  });
  await step('pagos a proveedores (completos y parciales)', async () => {
    for (const p of purchases) {
      if (p.ago < 20) continue; // las más recientes quedan por pagar
      const total = p.totals.total - (p.withholdingsTotal ?? 0);
      const open = p.balance ?? total;
      if (open <= 0) continue;
      const partial = rand() < 0.2;
      const amount = partial ? Math.round(open / 2 / 100) * 100 : open;
      await api('POST', '/payments', {
        partyId: p.supplier?.partyId ?? p.supplierId, date: iso(Math.max(p.ago - between(8, 25), 1)), paymentAccount: '111005', notes: `Pago ${p.supplierDocNumber}`,
        allocations: [{ purchaseId: p._id, amount }],
      }, { key: true });
    }
  });
  await step('nota crédito de proveedor y compra anulada', async () => {
    await api('POST', `/purchases/${purchases[2]._id}/credit-notes`, { reason: 'Cajas dañadas en el transporte', supplierDocNumber: 'NC-BH-101', issueDate: iso(110), lines: [{ lineIndex: 0, quantity: qty(6) }] }, { key: true });
    const bad = await api('POST', '/purchases', {
      supplierId: supplier('Papelería')._id, supplierDocNumber: 'PE-001', issueDate: iso(40),
      lines: [{ description: 'Papelería de oficina (digitada dos veces)', quantity: qty(1), unitPrice: cop(180_000), vatBps: 1900, accountId: '519595', costCenter: 'ADM' }],
    }, { key: true });
    await api('POST', `/purchases/${bad.purchase._id}/void`, {});
  });

  await step('ajustes y traspasos de inventario', async () => {
    await api('POST', '/stock/adjustments', { itemId: items.HUE30._id, warehouseId: whMain._id, date: iso(50), direction: 'out', quantity: qty(6), counterAccount: '529595', reason: 'Huevos rotos en bodega' }, { key: true });
    await api('POST', '/stock/adjustments', { itemId: items.CAF250._id, warehouseId: whMain._id, date: iso(33), direction: 'out', quantity: qty(4), counterAccount: '529595', reason: 'Producto vencido' }, { key: true });
    await api('POST', '/stock/adjustments', { itemId: items.JAB3._id, warehouseId: whMain._id, date: iso(28), direction: 'in', quantity: qty(12), unitCost: cop(5100), counterAccount: '310505', reason: 'Sobrante en conteo físico' }, { key: true });
    for (const [sku, units] of [['ARR500', 220], ['AZU1K', 160], ['LEC1L', 240], ['ACE1L', 80], ['CAF250', 90], ['DET2K', 45], ['JAB3', 70], ['PAP12', 40], ['GAS350', 30], ['AGU600', 25], ['HUE30', 30]]) {
      await api('POST', '/stock/transfers', { itemId: items[sku]._id, fromWarehouseId: whMain._id, toWarehouseId: whShop._id, date: iso(58), quantity: qty(units), note: 'Surtido de la tienda' }, { key: true });
    }
  });

  // ------------------------------------------------------------------ ventas
  log('Ventas, cobros y notas crédito');
  const invoices = [];
  const goodsSkus = GOODS.map((g) => g[0]);
  const saleLine = (sku, units, warehouseId, discountBps) => ({
    description: items[sku].name, quantity: qty(units), unitPrice: cop(priceOf(sku)), vatBps: vatOf(sku), itemId: items[sku]._id, warehouseId, costCenter: 'VEN', ...(discountBps ? { discountBps } : {}),
  });
  await step('facturas de venta (contado y crédito)', async () => {
    const days = [];
    for (let ago = 112; ago >= 2; ago -= between(2, 5)) days.push(ago);
    for (const ago of days) {
      const buyer = pick(customers.slice(0, 7));
      const credit = rand() < 0.6;
      const lines = [];
      const used = new Set();
      for (let n = between(2, 4); n > 0; n -= 1) {
        const sku = pick(goodsSkus);
        if (used.has(sku)) continue;
        used.add(sku);
        const big = ['GAS350', 'AGU600', 'HUE30'].includes(sku);
        lines.push(saleLine(sku, big ? between(2, 8) : between(8, 30), whMain._id, rand() < 0.15 ? 500 : 0));
      }
      if (rand() < 0.25) lines.push({ description: SERVICES[0][1], quantity: qty(1), unitPrice: cop(8000), vatBps: 1900, accountId: '414505', costCenter: 'VEN' });
      const out = await api('POST', '/invoices', {
        customerId: buyer._id, issueDate: iso(ago), paymentMethod: credit ? 'credit' : 'cash', ...(credit ? { dueDate: iso(ago - 30) } : {}), lines,
        notes: credit ? 'Pago a 30 días' : 'Pago de contado',
      }, { key: true });
      invoices.push({ ...(out.invoice ?? out), ago, buyer, credit });
    }
  });
  await step('factura de servicio de exhibición', async () => {
    const out = await api('POST', '/invoices', {
      customerId: customer('Supermercado')._id, issueDate: iso(35), paymentMethod: 'credit', dueDate: iso(5),
      lines: [{ description: SERVICES[1][1], quantity: qty(2), unitPrice: cop(150_000), vatBps: 1900, accountId: '414505', costCenter: 'VEN' }],
    }, { key: true });
    invoices.push({ ...(out.invoice ?? out), ago: 35, buyer: customer('Supermercado'), credit: true });
  });
  await step('recibos de caja (cobros completos, parciales y con retención)', async () => {
    let i = 0;
    for (const inv of invoices) {
      if (!inv.credit || inv.balance <= 0) continue;
      i += 1;
      if (inv.ago < 28 || i % 3 === 0) continue; // las recientes y 1 de cada 3 quedan abiertas: así hay cartera por edades
      const partial = i % 4 === 0;
      const amount = partial ? Math.round(inv.balance * 0.4 / 100) * 100 : inv.balance;
      const withholdings = !partial && inv.totals.subtotal > cop(1_000_000) ? [{ name: 'Retefuente 2,5 %', accountId: '135515', amount: Math.round(inv.totals.subtotal * 0.025) }] : [];
      await api('POST', '/receipts', {
        partyId: inv.buyer._id, date: iso(Math.max(inv.ago - between(10, 24), 1)), depositAccount: i % 5 === 0 ? '110505' : '111005',
        notes: 'Pago a la factura', allocations: [{ invoiceId: inv._id, amount }], withholdings,
      }, { key: true });
    }
  });
  await step('nota crédito parcial por devolución', async () => {
    const target = invoices.find((x) => x.ago < 90 && x.ago > 40 && x.lines?.length > 0) ?? invoices[5];
    await api('POST', `/invoices/${target._id}/credit-notes`, { reasonCode: '1', issueDate: iso(Math.max(target.ago - 4, 1)), lines: [{ lineIndex: 0, quantity: qty(2) }] }, { key: true });
    const target2 = invoices.find((x) => x.ago < 30 && x !== target);
    await api('POST', `/invoices/${target2._id}/credit-notes`, { reasonCode: '3', issueDate: iso(Math.max(target2.ago - 1, 0)), all: true }, { key: true });
  });

  await step('cotizaciones (abierta, aceptada y facturada, rechazada, anulada)', async () => {
    const q = async (buyer, skus, validUntil) =>
      api('POST', '/quotes', { customerId: buyer._id, issueDate: iso(14), validUntil, notes: 'Precios válidos hasta la fecha de vigencia', lines: skus.map(([sku, u]) => saleLine(sku, u, whMain._id)) });
    await q(customer('Hotel'), [['ARR500', 60], ['ACE1L', 24], ['CAF250', 30]], iso(-16));
    const accepted = await q(customer('Restaurante'), [['AZU1K', 40], ['HUE30', 6]], iso(-10));
    await api('POST', `/quotes/${accepted._id}/accept`);
    const toInvoice = await q(customer('Colegio'), [['LEC1L', 50], ['PAP12', 12]], iso(-5));
    await api('POST', `/quotes/${toInvoice._id}/accept`);
    await api('POST', `/quotes/${toInvoice._id}/invoice`, { paymentMethod: 'credit', issueDate: iso(3), dueDate: iso(-27) });
    const rejected = await q(customer('Cooperativa'), [['GAS350', 5]], iso(-3));
    await api('POST', `/quotes/${rejected._id}/reject`);
    const voided = await q(customer('Tienda'), [['JAB3', 20]], iso(-2));
    await api('POST', `/quotes/${voided._id}/void`);
  });

  await step('órdenes de compra (abierta, recibida, anulada)', async () => {
    const po = (who, skus, expected) =>
      api('POST', '/purchase-orders', {
        supplierId: supplier(who)._id, issueDate: iso(9), expectedDate: iso(expected), notes: 'Pedido de reposición',
        lines: skus.map(([sku, u]) => lineOf(sku, u, whMain._id)),
      });
    await po('Alimentos del Valle', [['ARR500', 400], ['LEC1L', 500], ['CAF250', 150]], -5);
    const received = await po('Bebidas del Huila', [['GAS350', 60], ['AGU600', 40]], 2);
    await api('POST', `/purchase-orders/${received._id}/receive`, { supplierDocNumber: 'BH-5911', issueDate: iso(4), dueDate: iso(-11) });
    const voided = await po('Aseo y Hogar', [['DET2K', 90]], 0);
    await api('POST', `/purchase-orders/${voided._id}/void`);
  });

  await step('facturas recurrentes (plantillas y ejecución)', async () => {
    await api('POST', '/recurring-invoices', {
      name: 'Suministro mensual de domicilios - Hotel Casa Real', customerId: customer('Hotel')._id, frequency: 'monthly', startDate: iso(95), paymentMethod: 'credit', dueDays: 15,
      notes: 'Servicio recurrente', lines: [{ description: SERVICES[0][1], quantity: qty(40), unitPrice: cop(8000), vatBps: 1900, accountId: '414505', costCenter: 'VEN' }],
    });
    await api('POST', '/recurring-invoices', {
      name: 'Montaje trimestral de exhibición - Supermercado La Economía', customerId: customer('Supermercado')._id, frequency: 'quarterly', startDate: iso(120), paymentMethod: 'credit', dueDays: 30,
      lines: [{ description: SERVICES[1][1], quantity: qty(1), unitPrice: cop(150_000), vatBps: 1900, accountId: '414505', costCenter: 'VEN' }],
    });
    const archived = await api('POST', '/recurring-invoices', {
      name: 'Plantilla pausada - Colegio San Agustín', customerId: customer('Colegio')._id, frequency: 'weekly', startDate: iso(10), paymentMethod: 'cash',
      lines: [{ description: SERVICES[0][1], quantity: qty(5), unitPrice: cop(8000), vatBps: 1900, accountId: '414505' }],
    });
    await api('PATCH', `/recurring-invoices/${archived._id}`, { active: false });
    await api('POST', '/recurring-invoices/run', { asOf: iso(0) });
  });

  await step('anticipos de cliente y a proveedor, con aplicación', async () => {
    const hotelInvoice = invoices.find((x) => x.buyer._id === customer('Hotel')._id && x.credit && x.ago < 28);
    const adv = await api('POST', '/customer-advances', { partyId: customer('Hotel')._id, date: iso(25), amount: cop(2_000_000), account: '111005', notes: 'Anticipo por pedido de temporada' }, { key: true });
    if (hotelInvoice) await api('POST', `/customer-advances/${adv.advance._id}/applications`, { date: iso(6), allocations: [{ documentId: hotelInvoice._id, amount: Math.min(cop(900_000), hotelInvoice.balance) }] }, { key: true });
    await api('POST', '/customer-advances', { partyId: customer('Cooperativa')._id, date: iso(8), amount: cop(1_200_000), account: '111005', notes: 'Anticipo sin aplicar' }, { key: true });
    const sadv = await api('POST', '/supplier-advances', { partyId: supplier('Distribuciones')._id, date: iso(22), amount: cop(1_500_000), account: '111005', notes: 'Anticipo de pedido' }, { key: true });
    const target = purchases.find((p) => p.who === 'Distribuciones Surandina' && p.ago === 12);
    if (target) await api('POST', `/supplier-advances/${sadv.advance._id}/applications`, { date: iso(8), allocations: [{ documentId: target._id, amount: cop(600_000) }] }, { key: true });
  });

  // ------------------------------------------------------------------ punto de venta
  log('Punto de venta');
  await step('caja, turnos cerrados con diferencia, ventas y anulación', async () => {
    const register = await api('POST', '/pos/registers', {
      code: 'CAJA1', name: 'Caja tienda Garzón', warehouseId: whShop._id, costCenter: 'GAR',
      accounts: { cash: '110505', card: '112005', transfer: '111005', shortage: '530595', surplus: '429595' },
    });
    const sell = async (ago, picks, payments) =>
      api('POST', '/pos/sales', {
        registerId: register._id, date: iso(ago), lines: picks.map(([sku, u]) => ({ description: items[sku].name, quantity: qty(u), unitPrice: cop(priceOf(sku)), vatBps: vatOf(sku), itemId: items[sku]._id })), payments,
      }, { key: true });
    const total = (picks) => picks.reduce((s, [sku, u]) => s + Math.round(priceOf(sku) * u * (1 + vatOf(sku) / 10_000)) * 100, 0);
    for (const [ago, offset] of [[40, -5000], [20, 3000], [6, 0]]) {
      const shift = await api('POST', `/pos/registers/${register._id}/shifts`, { openingCash: cop(200_000) });
      let cash = cop(200_000);
      for (let n = 0; n < 5; n += 1) {
        const picks = [[pick(goodsSkus.filter((s) => !['GAS350', 'AGU600', 'HUE30'].includes(s))), between(1, 4)], [pick(['LEC1L', 'ARR500', 'AZU1K']), between(1, 6)]];
        const sum = total(picks);
        const kind = n % 3;
        if (kind === 0) {
          const sale = await sell(ago, picks, [{ method: 'cash', amount: sum }]);
          cash += sum;
          if (ago === 20 && n === 0) await api('POST', `/pos/sales/${sale.sale._id}/void`, { reason: 'Cliente se arrepintió de la compra', date: iso(ago) }).then(() => { cash -= sum; });
        } else if (kind === 1) await sell(ago, picks, [{ method: 'card', amount: sum }]);
        else {
          const half = Math.round(sum / 2 / 100) * 100;
          await sell(ago, picks, [{ method: 'transfer', amount: half }, { method: 'cash', amount: sum - half }]);
          cash += sum - half;
        }
      }
      await api('POST', `/pos/shifts/${shift._id}/close`, { countedCash: Math.max(cash + cop(offset), 0), date: iso(ago), notes: offset ? 'Diferencia en el arqueo' : 'Arqueo sin novedades' });
    }
    await api('POST', `/pos/registers/${register._id}/shifts`, { openingCash: cop(150_000) }); // turno abierto hoy
    await sell(0, [['LEC1L', 3], ['ARR500', 2]], [{ method: 'cash', amount: total([['LEC1L', 3], ['ARR500', 2]]) }]);
    await sell(0, [['CAF250', 1], ['AZU1K', 2]], [{ method: 'card', amount: total([['CAF250', 1], ['AZU1K', 2]]) }]);
    await api('POST', '/pos/registers', { code: 'CAJA2', name: 'Caja de respaldo', accounts: { cash: '110505' } });
  });

  // ------------------------------------------------------------------ nómina
  log('Nómina');
  const employees = [];
  await step('parámetros del año y cuentas de nómina', async () => {
    await api('PUT', '/payroll/config/accounts', { accounts: PAYROLL_ACCOUNTS });
    await api('PUT', `/payroll/config/years/${year}`, { params: { smmlv: cop(1_750_905), transportAid: cop(249_095), uvt: cop(52_374) } });
  });
  await step('empleados', async () => {
    const defs = [
      { documentType: 'CC', documentNumber: '36152001', name: 'Marta Lucía Quintero', hireDate: '2023-02-01', baseSalary: cop(4_200_000), position: 'Gerente administrativa', costCenter: 'ADM', arlRiskLevel: 1, transportAid: false, contractType: 'indefinite', email: 'marta@andinahuila.example' },
      { documentType: 'CC', documentNumber: '1075240111', name: 'Carlos Andrés Rojas', hireDate: '2024-05-15', baseSalary: cop(2_300_000), position: 'Jefe de bodega', costCenter: 'BOD', arlRiskLevel: 3, contractType: 'indefinite' },
      { documentType: 'CC', documentNumber: '1075250222', name: 'Diana Carolina Pérez', hireDate: '2024-09-02', baseSalary: cop(1_750_905), position: 'Cajera', costCenter: 'GAR', arlRiskLevel: 1, contractType: 'indefinite' },
      { documentType: 'CC', documentNumber: '1075260333', name: 'Juan Sebastián Cabrera', hireDate: '2025-01-13', baseSalary: cop(1_900_000), position: 'Vendedor de ruta', costCenter: 'VEN', arlRiskLevel: 2, contractType: 'fixed' },
      { documentType: 'CC', documentNumber: '1075270444', name: 'Paola Andrea Muñoz', hireDate: '2025-06-02', baseSalary: cop(2_800_000), position: 'Contadora auxiliar', costCenter: 'ADM', arlRiskLevel: 1, contractType: 'indefinite' },
      { documentType: 'CC', documentNumber: '1075280555', name: 'Jorge Iván Ramírez', hireDate: '2025-03-10', baseSalary: cop(1_800_000), position: 'Auxiliar de bodega', costCenter: 'BOD', arlRiskLevel: 3, contractType: 'indefinite' },
    ];
    for (const e of defs) employees.push(await api('POST', '/payroll/employees', e));
    await api('PATCH', `/payroll/employees/${employees[3]._id}`, { baseSalary: cop(2_000_000) });
  });
  const payrollRuns = [];
  await step('liquidaciones de nómina mensuales (enero a mes anterior)', async () => {
    for (let m = 1; m <= today.getUTCMonth() + 1; m += 1) {
      const period = `${year}-${String(m).padStart(2, '0')}`;
      const novelties = m % 3 === 0 ? [{ employeeId: employees[1]._id, salaryExtras: cop(180_000) }, { employeeId: employees[3]._id, nonSalaryExtras: cop(250_000) }] : [];
      payrollRuns.push(await api('POST', '/payroll/runs', { period, novelties }, { key: true }));
    }
  });
  await step('pago de nóminas y aportes', async () => {
    for (const [i, r] of payrollRuns.entries()) {
      const run = r.run ?? r;
      const monthEnd = new Date(Date.UTC(year, i + 1, 0)).toISOString().slice(0, 10);
      if (monthEnd > iso(0)) continue;
      await api('POST', `/payroll/runs/${run._id}/pay`, { date: monthEnd, account: '111005' });
      if (i < payrollRuns.length - 1) await api('POST', `/payroll/runs/${run._id}/pay-contributions`, { date: monthEnd, account: '111005' });
    }
  });
  await step('prima de servicios del primer semestre', async () => {
    await api('POST', '/payroll/benefits/preview', { kind: 'prima', label: `${year}-1` });
    const prima = await api('POST', '/payroll/benefits', { kind: 'prima', label: `${year}-1` });
    await api('POST', `/payroll/benefits/${(prima.benefit ?? prima)._id}/pay`, { date: `${year}-06-28`, account: '111005' });
  });
  await step('liquidación de contrato de un empleado', async () => {
    const endDate = iso(12);
    await api('POST', '/payroll/terminations/preview', { employeeId: employees[5]._id, endDate, vacationDaysPending: 6 });
    const t = await api('POST', '/payroll/terminations', { employeeId: employees[5]._id, endDate, vacationDaysPending: 6 });
    await api('POST', `/payroll/terminations/${(t.termination ?? t)._id}/pay`, { date: iso(10), account: '111005' });
  });

  // ------------------------------------------------------------------ asientos manuales, presupuesto, impuestos
  log('Contabilidad, presupuesto e impuestos');
  await step('asientos manuales (gastos bancarios, publicidad, diversos y uno reversado)', async () => {
    for (let m = 1; m <= today.getUTCMonth(); m += 1) {
      const date = `${year}-${String(m).padStart(2, '0')}-28`;
      await journal(date, 'Cuota de manejo y comisiones bancarias', [{ accountId: '530505', debit: cop(38_500), costCenter: 'ADM' }, { accountId: '111005', credit: cop(38_500) }]);
    }
    await journal(iso(70), 'Pauta en emisora local', [{ accountId: '523505', debit: cop(850_000), costCenter: 'VEN' }, { accountId: '111005', credit: cop(850_000) }]);
    await journal(iso(44), 'Reintegro de caja menor', [{ accountId: '519595', debit: cop(120_000), costCenter: 'ADM' }, { accountId: '110505', credit: cop(120_000) }]);
    const wrong = await journal(iso(30), 'Gasto mal digitado (se reversa)', [{ accountId: '519595', debit: cop(999_000), costCenter: 'ADM' }, { accountId: '110505', credit: cop(999_000) }]);
    await api('POST', `/journals/${wrong.journal._id}/reverse`, { date: iso(29), description: 'Reverso de asiento digitado por error' }, { key: true });
  });
  await step('presupuesto del año', async () => {
    const flat = (pesos) => Array.from({ length: 12 }, () => cop(pesos));
    const ramp = (from, to) => Array.from({ length: 12 }, (_, i) => cop(Math.round(from + ((to - from) * i) / 11)));
    await api('PUT', `/budgets/${year}`, {
      lines: [
        { accountId: '413505', months: ramp(45_000_000, 80_000_000) },
        { accountId: '414505', months: flat(600_000) },
        { accountId: '613505', months: ramp(33_000_000, 58_000_000) },
        { accountId: '512010', costCenter: 'ADM', months: flat(4_500_000) },
        { accountId: '513525', costCenter: 'GAR', months: flat(700_000) },
        { accountId: '510506', months: flat(14_500_000) },
        { accountId: '523505', costCenter: 'VEN', months: flat(500_000) },
      ],
    });
  });
  await step('cierre de IVA del bimestre anterior', async () => {
    const closeMonth = today.getUTCMonth() >= 2 ? today.getUTCMonth() - 1 : 0; // último mes cerrado completo
    const to = new Date(Date.UTC(year, closeMonth, 0)).toISOString().slice(0, 10);
    const from = new Date(Date.UTC(year, closeMonth - 2, 1)).toISOString().slice(0, 10);
    await api('GET', `/taxes/vat-close/preview?from=${from}&to=${to}&currency=COP`);
    await api('POST', '/taxes/vat-closes', { from, to, currency: 'COP', dueAccount: '240815', creditAccount: '135520' });
  });

  // ------------------------------------------------------------------ conciliación bancaria
  log('Conciliación bancaria');
  await step('extracto importado, conciliación automática y cierre', async () => {
    const asOf = iso(20);
    const all = [];
    let cursor;
    do {
      const page = await api('GET', `/journals?accountId=111005&limit=500${cursor ? `&cursor=${cursor}` : ''}`);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const lines = [];
    for (const j of all) {
      const day = String(j.date).slice(0, 10);
      if (day > asOf) continue;
      for (const l of j.lines.filter((x) => x.accountId === '111005')) {
        const amount = (l.debit ?? 0) - (l.credit ?? 0);
        if (amount !== 0) lines.push({ date: day, description: `${j.docType} ${j.number ?? ''} ${j.description ?? ''}`.trim().slice(0, 200), reference: String(j.number ?? '').slice(0, 60), amount });
      }
    }
    // Dos movimientos del libro quedan sin extracto (cheques en tránsito): la conciliación sigue cuadrando por partidas abiertas.
    const skipped = lines.splice(lines.length - 2, 2);
    for (let i = 0; i < lines.length; i += 500) await api('POST', '/bank/lines', { account: '111005', lines: lines.slice(i, i + 500) });
    await api('POST', '/bank/matches/auto', { account: '111005', days: 3 });
    const statementBalance = lines.reduce((s, l) => s + l.amount, 0);
    const summary = await api('GET', `/bank/reconciliation?account=111005&asOf=${asOf}&statementBalance=${statementBalance}`);
    log(`      extracto: ${lines.length} líneas, ${skipped.length} del libro en tránsito, diferencia ${summary.difference}`);
    await api('POST', '/bank/reconciliations', { account: '111005', asOf, statementBalance });
  });
  await step('movimientos recientes del banco por contabilizar', async () => {
    await api('POST', '/bank/lines', {
      account: '111005',
      lines: [
        { date: iso(9), description: 'Cuota de manejo cuenta corriente', reference: 'CM-0910', amount: -cop(38_500) },
        { date: iso(7), description: 'Rendimientos financieros', reference: 'RF-0912', amount: cop(18_300) },
        { date: iso(3), description: 'Transferencia recibida Panadería La Espiga', reference: 'TR-4471', amount: cop(640_000) },
      ],
    });
    const open = (await api('GET', `/bank/lines?account=111005&from=${iso(15)}&to=${iso(0)}&status=open`)).items;
    const fee = open.find((l) => l.description.startsWith('Cuota'));
    if (fee) await api('POST', `/bank/lines/${fee._id}/book`, { counterAccount: '530505', description: 'Cuota de manejo contabilizada desde el extracto', costCenter: 'ADM' });
  });

  // ------------------------------------------------------------------ equipo y claves
  log('Equipo y claves de API');
  await step('miembros con distintos roles', async () => {
    const team = [
      ['contadora@lulubiz.test', 'Paola Muñoz (contadora)', 'accountant'],
      ['cajero@lulubiz.test', 'Diana Pérez (cajera)', 'cashier'],
      ['consulta@lulubiz.test', 'Revisoría fiscal (solo lectura)', 'viewer'],
      ['admin@lulubiz.demo', 'Andrés Cuéllar (administrador)', 'admin'],
    ];
    for (const [memberEmail, name, role] of team) {
      await api('POST', '/members', { email: memberEmail, role });
      const token = decodeURIComponent(mailer.last(memberEmail).text.match(/#token=([^\s]+)/)[1]);
      await api('POST', '/v1/invitations/accept', { token, name, password });
    }
    await api('POST', '/members', { email: 'pendiente@lulubiz.test', role: 'accountant' }); // invitación sin aceptar
  });
  await step('claves de API', async () => {
    await api('POST', '/api-keys', { name: 'Tienda en línea (solo facturar)', scopes: ['invoices:read', 'invoices:issue', 'inventory:read', 'parties:read', 'parties:manage'] });
    await api('POST', '/api-keys', { name: 'Tablero de informes', scopes: ['reports:read'], expiresAt: iso(-180) });
    const old = await api('POST', '/api-keys', { name: 'Integración anterior (revocada)', scopes: ['inventory:read'] });
    await api('POST', `/api-keys/${(old.apiKey ?? old)._id}/revoke`);
  });

  // ------------------------------------------------------------------ cierre de períodos antiguos
  log('Períodos');
  await step('cierre de los primeros meses del año', async () => {
    for (const m of [1, 2, 3]) await api('POST', `/periods/${year}-${String(m).padStart(2, '0')}/close`);
  });

  await app.close();
  log(failures.length ? `\nTerminó con ${failures.length} paso(s) fallidos:\n${failures.map((f) => `  - ${f}`).join('\n')}` : '\nTodo el seed corrió sin fallos.');
  return { email, password, failures, tenantId: reg.data.tenantId };
}

// ---------------------------------------------------------------------------------------------- línea de comandos

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seedDemo.js')) {
  if (process.env.NODE_ENV === 'production') {
    console.error('npm run seed:demo no corre en producción');
    process.exit(1);
  }
  const memory = process.argv.includes('--memory');
  const [email, password] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const config = loadConfig();
  let stop = async () => {};
  let client;
  let dbName = config.dbName;
  if (memory) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const repl = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 60_000, args: ['--setParameter', 'diagnosticDataCollectionEnabled=false'] }], replSet: { count: 1 } });
    client = await MongoClient.connect(repl.getUri());
    dbName = 'lulubiz_seed_demo';
    stop = () => repl.stop();
    console.log('Probando en una base en memoria (no se guarda nada).');
  } else {
    client = await MongoClient.connect(config.mongoUri);
    console.log(`Base: ${dbName}`);
  }
  const db = client.db(dbName);
  await ensureIndexes(db);
  try {
    const result = await seedDemo({ client, db, config, ...(email ? { email } : {}), ...(password ? { password } : {}) });
    console.log(`\nListo. Entra con  ${result.email}  /  ${result.password}`);
    process.exitCode = result.failures.length ? 1 : 0;
  } catch (err) {
    console.error(`\nSeed detenido: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
    await stop();
  }
}
