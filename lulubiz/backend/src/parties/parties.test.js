import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthService } from '../auth/auth.js';
import { computeNitCheckDigit, validateColombianTaxId } from '../countries/co/taxId.js';
import { ensureIndexes } from '../data/db.js';
import { startMongo } from '../testing/mongo.js';
import { PartyError, createPartyService } from './parties.js';

let mongo;
let db;
let parties;
let tenantCO;
let tenantUS;

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

const customer = (overrides = {}) => ({
  name: 'Droguería Los Andes',
  roles: ['customer'],
  taxIdType: 'NIT',
  taxId: '890903938',
  checkDigit: 8,
  email: 'Compras@Andes.co',
  ...overrides,
});

beforeAll(async () => {
  mongo = await startMongo('lulubiz_parties_test');
  db = mongo.db;
  parties = createPartyService(mongo.client, db);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  ({ tenantId: tenantCO } = await auth.registerTenant({
    companyName: 'Empresa CO', country: 'CO', currency: 'COP', ownerName: 'A', email: 'a@co.co', password: 'correcto-caballo-grapa',
  }));
  ({ tenantId: tenantUS } = await auth.registerTenant({
    companyName: 'Empresa US', country: 'US', currency: 'USD', ownerName: 'B', email: 'b@us.com', password: 'correcto-caballo-grapa',
  }));
});

describe('NIT de Colombia', () => {
  it('calcula el dígito de verificación de NIT conocidos', () => {
    expect(computeNitCheckDigit('800197268')).toBe(4); // DIAN
    expect(computeNitCheckDigit('899999068')).toBe(1); // Ecopetrol
    expect(computeNitCheckDigit('890903938')).toBe(8); // Bancolombia
  });

  it('rechaza un dígito incorrecto y acepta el correcto', () => {
    expect(validateColombianTaxId({ taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 })).toEqual([]);
    expect(validateColombianTaxId({ taxIdType: 'NIT', taxId: '800197268', checkDigit: 5 })[0]).toMatch(/incorrecto/);
    expect(validateColombianTaxId({ taxIdType: 'NIT', taxId: '800197268' })[0]).toMatch(/necesita/);
    expect(validateColombianTaxId({ taxIdType: 'NIT', taxId: '80x197268', checkDigit: 4 })[0]).toMatch(/dígitos/);
  });

  it('valida las cédulas y los tipos desconocidos', () => {
    expect(validateColombianTaxId({ taxIdType: 'CC', taxId: '1075123456' })).toEqual([]);
    expect(validateColombianTaxId({ taxIdType: 'CC', taxId: '12' })).not.toEqual([]);
    expect(validateColombianTaxId({ taxIdType: 'RUC', taxId: '123456' })[0]).toMatch(/no válido/);
  });
});

describe('terceros: creación', () => {
  it('crea un cliente con NIT válido y normaliza correo, puntos y espacios', async () => {
    const p = await parties.create(tenantCO, customer({ taxId: '890.903.938 ' }));
    expect(p).toMatchObject({ taxId: '890903938', checkDigit: 8, email: 'compras@andes.co', active: true, roles: ['customer'] });
    expect(p.nameKey).toBe('drogueria los andes');
  });

  it('rechaza NIT con dígito incorrecto, roles vacíos o inválidos y correo inválido', async () => {
    expect(await code(parties.create(tenantCO, customer({ checkDigit: 3 })))).toBe('VALIDATION');
    expect(await code(parties.create(tenantCO, customer({ roles: [] })))).toBe('VALIDATION');
    expect(await code(parties.create(tenantCO, customer({ roles: ['socio'] })))).toBe('VALIDATION');
    expect(await code(parties.create(tenantCO, customer({ email: 'no-es-correo' })))).toBe('VALIDATION');
    expect(await code(parties.create(tenantCO, customer({ name: '   ' })))).toBe('VALIDATION');
  });

  it('un tercero puede ser cliente y proveedor a la vez', async () => {
    const p = await parties.create(tenantCO, customer({ roles: ['supplier', 'customer', 'customer'] }));
    expect(p.roles).toEqual(['customer', 'supplier']);
  });

  it('rechaza el mismo documento dos veces en la misma empresa, pero lo permite en otra', async () => {
    await parties.create(tenantCO, customer());
    expect(await code(parties.create(tenantCO, customer({ name: 'Otra' })))).toBe('DUPLICATE');
    const other = await parties.create(tenantUS, customer({ taxIdType: 'TAX_ID', taxId: '890903938', checkDigit: undefined }));
    expect(other.taxId).toBe('890903938');
  });

  it('usa la validación genérica para países sin paquete', async () => {
    expect(await code(parties.create(tenantUS, customer({ taxIdType: 'NIT' })))).toBe('VALIDATION');
    expect(await code(parties.create(tenantUS, customer({ taxIdType: 'TAX_ID', taxId: '12' })))).toBe('VALIDATION');
  });

  it('rechaza una empresa inexistente', async () => {
    expect(await code(parties.create(new ObjectId(), customer()))).toBe('NOT_FOUND');
  });
});

describe('terceros: edición', () => {
  it('edita nombre, roles y contacto, pero nunca la identificación', async () => {
    const p = await parties.create(tenantCO, customer());
    const updated = await parties.update(tenantCO, p._id, { name: 'Droguería Andes SAS', roles: ['supplier'], phone: '3001234567' });
    expect(updated).toMatchObject({ name: 'Droguería Andes SAS', roles: ['supplier'], phone: '3001234567' });
    expect(updated.nameKey).toBe('drogueria andes sas');
    expect(await code(parties.update(tenantCO, p._id, { taxId: '800197268' }))).toBe('IMMUTABLE');
    expect(await code(parties.update(tenantCO, p._id, { taxIdType: 'CC' }))).toBe('IMMUTABLE');
  });

  it('una empresa no ve ni edita los terceros de otra', async () => {
    const p = await parties.create(tenantCO, customer());
    expect(await parties.get(tenantUS, p._id)).toBeNull();
    expect(await code(parties.update(tenantUS, p._id, { name: 'Robo' }))).toBe('NOT_FOUND');
    expect(await code(parties.setActive(tenantUS, p._id, false))).toBe('NOT_FOUND');
    expect((await parties.get(tenantCO, p._id)).active).toBe(true);
  });

  it('desactiva y reactiva', async () => {
    const p = await parties.create(tenantCO, customer());
    await parties.setActive(tenantCO, p._id, false);
    expect((await parties.get(tenantCO, p._id)).active).toBe(false);
    expect((await parties.list(tenantCO, { activeOnly: true })).items).toHaveLength(0);
    await parties.setActive(tenantCO, p._id, true);
    expect((await parties.list(tenantCO, { activeOnly: true })).items).toHaveLength(1);
  });
});

describe('terceros: listado', () => {
  beforeEach(async () => {
    const names = ['Ángela Pérez', 'Almacén Central', 'Bodega Norte', 'Aceros del Sur'];
    for (const [i, name] of names.entries()) {
      await parties.create(tenantCO, {
        name,
        roles: [i % 2 === 0 ? 'customer' : 'supplier'],
        taxIdType: 'CC',
        taxId: String(10_000_000 + i),
      });
    }
  });

  it('pagina con cursor sin repetir ni saltar', async () => {
    const first = await parties.list(tenantCO, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await parties.list(tenantCO, { limit: 3, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((p) => p._id.toHexString());
    expect(new Set(ids).size).toBe(4);
  });

  it('filtra por rol y busca por prefijo sin importar tildes ni mayúsculas, o por documento', async () => {
    expect((await parties.list(tenantCO, { role: 'supplier' })).items.map((p) => p.name).sort()).toEqual(['Aceros del Sur', 'Almacén Central']);
    expect((await parties.list(tenantCO, { role: 'customer' })).items.map((p) => p.name).sort()).toEqual(['Bodega Norte', 'Ángela Pérez']);
    expect((await parties.list(tenantCO, { search: 'ANGELA' })).items.map((p) => p.name)).toEqual(['Ángela Pérez']);
    expect((await parties.list(tenantCO, { search: 'al' })).items.map((p) => p.name)).toEqual(['Almacén Central']);
    expect((await parties.list(tenantCO, { search: '10000002' })).items).toHaveLength(1);
  });

  it('la búsqueda trata los símbolos como texto, no como expresión regular', async () => {
    expect((await parties.list(tenantCO, { search: '.*' })).items).toHaveLength(0);
    expect((await parties.list(tenantCO, { search: '(' })).items).toHaveLength(0);
  });

  it('limita el tamaño de página', async () => {
    expect((await parties.list(tenantCO, { limit: 100000 })).items.length).toBeLessThanOrEqual(100);
    expect(await code(parties.list(tenantCO, { role: 'socio' }))).toBe('VALIDATION');
  });

  it('no mezcla empresas', async () => {
    expect((await parties.list(tenantUS)).items).toHaveLength(0);
  });
});
