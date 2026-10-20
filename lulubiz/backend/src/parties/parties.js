import { ObjectId } from 'mongodb';
import { validateTaxIdFor } from '../countries/index.js';
import { toNameKey } from '../core/text.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { DUPLICATE_KEY, withTransaction } from '../data/tx.js';

export class PartyError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'PartyError';
    this.code = code;
  }
}

export const PARTY_ROLES = ['customer', 'supplier'];
export const MAX_PAGE_SIZE = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*
 * Tercero (cliente o proveedor), referencia sin tipos:
 * { _id, tenantId, roles ['customer'|'supplier'], name, nameKey, taxIdType, taxId, checkDigit?,
 *   email?, phone?, address? { line, city, region, country }, active, createdAt, updatedAt }
 *
 * - La identificación (tipo y número) no se edita: es lo que identifica al tercero frente a la
 *   autoridad tributaria y a los documentos ya emitidos. Si estaba mal, se desactiva y se crea otro.
 * - La validación de la identificación la define el paquete de país de la empresa.
 * - `nameKey` es el nombre en minúsculas y sin tildes, para buscar por prefijo sin distinguir.
 */

function cleanText(value, label, { required = false, max = 200 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    if (required) throw new PartyError(`falta ${label}`);
    return undefined;
  }
  if (text.length > max) throw new PartyError(`${label} admite como máximo ${max} caracteres`);
  return text;
}

function cleanRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) throw new PartyError('indica si es cliente, proveedor o ambos');
  const unique = [...new Set(roles)];
  if (!unique.every((r) => PARTY_ROLES.includes(r))) throw new PartyError(`rol de tercero inválido: ${roles}`);
  return unique.sort();
}

function cleanContact(input) {
  const email = cleanText(input.email, 'el correo', { max: 254 })?.toLowerCase();
  if (email && !EMAIL_PATTERN.test(email)) throw new PartyError('correo inválido');
  const phone = cleanText(input.phone, 'el teléfono', { max: 30 });
  let address;
  if (input.address) {
    address = {
      line: cleanText(input.address.line, 'la dirección', { max: 200 }),
      city: cleanText(input.address.city, 'la ciudad', { max: 100 }),
      region: cleanText(input.address.region, 'el departamento o región', { max: 100 }),
      country: cleanText(input.address.country, 'el país', { max: 2 })?.toUpperCase(),
    };
  }
  return {
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
  };
}

export function createPartyService(client, db) {
  const partiesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.parties), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  return {
    async create(tenantId, input, { inTx } = {}) {
      const tenant = await tenants.findOne({ _id: tenantId }, { projection: { country: 1 } });
      if (!tenant) throw new PartyError('la empresa no existe', 'NOT_FOUND');

      const name = cleanText(input.name, 'el nombre', { required: true });
      const taxIdType = String(input.taxIdType ?? '');
      const taxId = String(input.taxId ?? '').trim().replace(/[.\s]/g, '');
      const checkDigit = input.checkDigit ?? undefined;
      const problems = validateTaxIdFor(tenant.country, { taxIdType, taxId, checkDigit });
      if (problems.length) throw new PartyError(problems.join('; '));

      const now = new Date();
      const doc = {
        roles: cleanRoles(input.roles),
        name,
        nameKey: toNameKey(name),
        taxIdType,
        taxId,
        ...(taxIdType === 'NIT' ? { checkDigit: Number(checkDigit) } : {}),
        ...cleanContact(input),
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      try {
        return await withTransaction(client, async (session) => {
          const { insertedId } = await partiesOf(tenantId).insertOne({ ...doc }, session);
          const party = { ...doc, _id: insertedId, tenantId };
          if (inTx) await inTx(session, party);
          return party;
        });
      } catch (err) {
        if (err?.code === DUPLICATE_KEY) throw new PartyError(`ya existe un tercero con ${taxIdType} ${taxId}`, 'DUPLICATE');
        throw err;
      }
    },

    get(tenantId, id) {
      return partiesOf(tenantId).findOne({ _id: new ObjectId(id) });
    },

    /** Edita nombre, roles y datos de contacto. La identificación no se toca (ver nota arriba). */
    async update(tenantId, id, changes, { inTx } = {}) {
      if ('taxId' in changes || 'taxIdType' in changes || 'checkDigit' in changes) {
        throw new PartyError('la identificación no se edita: desactiva el tercero y crea otro', 'IMMUTABLE');
      }
      const set = { updatedAt: new Date() };
      if ('name' in changes) {
        set.name = cleanText(changes.name, 'el nombre', { required: true });
        set.nameKey = toNameKey(set.name);
      }
      if ('roles' in changes) set.roles = cleanRoles(changes.roles);
      Object.assign(set, cleanContact(changes));
      await withTransaction(client, async (session) => {
        const result = await partiesOf(tenantId).updateOne({ _id: new ObjectId(id) }, { $set: set }, { session });
        if (result.matchedCount === 0) throw new PartyError('el tercero no existe', 'NOT_FOUND');
        if (inTx) await inTx(session, { id, fields: Object.keys(changes) });
      });
      return this.get(tenantId, id);
    },

    async setActive(tenantId, id, active, { inTx } = {}) {
      await withTransaction(client, async (session) => {
        const result = await partiesOf(tenantId).updateOne(
          { _id: new ObjectId(id) },
          { $set: { active: Boolean(active), updatedAt: new Date() } },
          { session },
        );
        if (result.matchedCount === 0) throw new PartyError('el tercero no existe', 'NOT_FOUND');
        if (inTx) await inTx(session, { id, active: Boolean(active) });
      });
    },

    /**
     * Lista paginada por `_id`. `search` busca por prefijo del nombre o por número de documento.
     * Devuelve `nextCursor` (null si no hay más) para pedir la página siguiente.
     */
    async list(tenantId, { role, search, activeOnly = false, limit = 50, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 50, 1), MAX_PAGE_SIZE);
      const filter = {};
      if (role) {
        if (!PARTY_ROLES.includes(role)) throw new PartyError(`rol de tercero inválido: ${role}`);
        filter.roles = role;
      }
      if (activeOnly) filter.active = true;
      if (search) {
        const term = String(search).trim();
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ nameKey: { $regex: `^${toNameKey(escaped)}` } }, { taxId: { $regex: `^${escaped}` } }];
      }
      if (cursor) filter._id = { $gt: new ObjectId(cursor) };

      const rows = await partiesOf(tenantId).find(filter, { sort: { _id: 1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },
  };
}
