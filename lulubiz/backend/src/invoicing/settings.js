import { validateTaxIdFor } from '../countries/index.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { withTransaction } from '../data/tx.js';

export class InvoicingError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'InvoicingError';
    this.code = code;
  }
}

export const REGIMES = ['responsable_iva', 'no_responsable'];
const ACCOUNT_CODE = /^[0-9]{1,12}$/;

const text = (value, label, { required = false, max = 200 } = {}) => {
  const clean = String(value ?? '').trim();
  if (!clean) {
    if (required) throw new InvoicingError(`falta ${label}`);
    return undefined;
  }
  if (clean.length > max) throw new InvoicingError(`${label} admite como máximo ${max} caracteres`);
  return clean;
};

/*
 * Configuración de facturación de una empresa (referencia, sin tipos):
 * { tenantId, issuer { name, taxIdType, taxId, checkDigit?, regime, email?, phone?, address { line, city, region, country } },
 *   accounts { receivable, income, vatPayable, cash?, payable?, vatDeductible?, customerAdvance?, supplierAdvance? }, updatedAt }
 *
 * - `issuer` es quien emite las facturas: sin él no se puede emitir ninguna.
 * - Un emisor `no_responsable` de IVA no puede facturar con IVA: se exige tarifa 0 en cada línea.
 * - `accounts` dice a qué cuentas contabiliza cada factura: por cobrar (o caja si se paga de contado y hay `cash`),
 *   ingresos (cuenta por defecto, cada línea puede traer otra) e IVA por pagar. `payable` (proveedores) y
 *   `vatDeductible` (IVA descontable) son de las compras y solo se exigen para registrar facturas de compra.
 *   `customerAdvance` (pasivo) y `supplierAdvance` (activo) son de los anticipos y solo se exigen para registrarlos.
 */
export function createSettingsService(client, db, accounts) {
  const settingsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.settings), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  return {
    get(tenantId) {
      return settingsOf(tenantId).findOne({});
    },

    async save(tenantId, input, { inTx } = {}) {
      const tenant = await tenants.findOne({ _id: tenantId }, { projection: { country: 1 } });
      if (!tenant) throw new InvoicingError('la empresa no existe', 'NOT_FOUND');

      const issuerInput = input.issuer ?? {};
      const taxIdType = String(issuerInput.taxIdType ?? '');
      const taxId = String(issuerInput.taxId ?? '').trim().replace(/[.\s]/g, '');
      const checkDigit = issuerInput.checkDigit ?? undefined;
      const problems = validateTaxIdFor(tenant.country, { taxIdType, taxId, checkDigit });
      if (problems.length) throw new InvoicingError(`identificación del emisor: ${problems.join('; ')}`);
      if (!REGIMES.includes(issuerInput.regime)) throw new InvoicingError('indica el régimen del emisor frente al IVA');
      const address = issuerInput.address ?? {};
      const issuer = {
        name: text(issuerInput.name, 'el nombre del emisor', { required: true }),
        taxIdType,
        taxId,
        ...(taxIdType === 'NIT' ? { checkDigit: Number(checkDigit) } : {}),
        regime: issuerInput.regime,
        ...(text(issuerInput.email, 'el correo del emisor', { max: 254 }) ? { email: text(issuerInput.email, 'el correo', { max: 254 }).toLowerCase() } : {}),
        ...(text(issuerInput.phone, 'el teléfono del emisor', { max: 30 }) ? { phone: text(issuerInput.phone, 'el teléfono', { max: 30 }) } : {}),
        address: {
          line: text(address.line, 'la dirección del emisor', { required: true }),
          city: text(address.city, 'la ciudad del emisor', { required: true, max: 100 }),
          region: text(address.region, 'el departamento del emisor', { required: true, max: 100 }),
          country: tenant.country,
        },
      };

      const accountsInput = input.accounts ?? {};
      const mapping = {};
      for (const [key, label, required] of [
        ['receivable', 'la cuenta por cobrar', true],
        ['income', 'la cuenta de ingresos', true],
        ['vatPayable', 'la cuenta de IVA por pagar', true],
        ['cash', 'la cuenta de caja', false],
        ['payable', 'la cuenta de proveedores', false],
        ['vatDeductible', 'la cuenta de IVA descontable', false],
        ['customerAdvance', 'la cuenta de anticipos de clientes', false],
        ['supplierAdvance', 'la cuenta de anticipos a proveedores', false],
      ]) {
        const code = String(accountsInput[key] ?? '').trim();
        if (!code) {
          if (required) throw new InvoicingError(`falta ${label}`);
          continue;
        }
        if (!ACCOUNT_CODE.test(code)) throw new InvoicingError(`${label} debe ser un código numérico`);
        mapping[key] = code;
      }
      const accountProblems = await accounts.postingProblems(tenantId, Object.values(mapping));
      if (accountProblems.length) throw new InvoicingError(accountProblems.join('; '));

      return withTransaction(client, async (session) => {
        const doc = { issuer, accounts: mapping, updatedAt: new Date() };
        await settingsOf(tenantId).updateOne({}, { $set: doc }, { upsert: true, session });
        if (inTx) await inTx(session, doc);
        return doc;
      });
    },
  };
}

/** Lo que falta para poder emitir. Lista vacía si la configuración está completa. */
export function missingSettings(settings) {
  if (!settings) return ['los datos del emisor y las cuentas contables'];
  const missing = [];
  if (!settings.issuer?.taxId) missing.push('los datos del emisor');
  for (const [key, label] of [['receivable', 'la cuenta por cobrar'], ['income', 'la cuenta de ingresos'], ['vatPayable', 'la cuenta de IVA por pagar']]) {
    if (!settings.accounts?.[key]) missing.push(label);
  }
  return missing;
}
