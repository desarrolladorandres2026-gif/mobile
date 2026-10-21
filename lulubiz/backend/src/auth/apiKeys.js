import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { DAY_MS, parseDay as parseCalendarDay } from '../core/dates.js';
import { COLLECTIONS } from '../data/db.js';
import { isDuplicate, withTransaction } from '../data/tx.js';
import { PERMISSIONS, can } from './permissions.js';

export const MAX_ACTIVE_KEYS = 20;
export const TOKEN_PATTERN = /^lbk_([a-f0-9]{8})_([A-Za-z0-9_-]{43})$/;
/** Lo que una clave nunca puede hacer, la tenga quien la tenga: administrar la empresa, sus usuarios, sus claves ni reabrir períodos. */
export const FORBIDDEN_SCOPES = ['tenant:manage', 'users:manage', 'apikeys:manage', 'periods:reopen', 'settings:manage'];
export const GRANTABLE_SCOPES = PERMISSIONS.filter((p) => !FORBIDDEN_SCOPES.includes(p));

export class ApiKeyError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'ApiKeyError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new ApiKeyError(message, code);
};
const sha256 = (value) => createHash('sha256').update(value).digest();
const INVALID = () => fail('la clave de API no es válida', 'INVALID_CREDENTIALS');
const TOUCH_EVERY_MS = 5 * 60_000;

/** Lo que se muestra de una clave: nunca su secreto ni su huella. */
const view = (k) => ({
  _id: k._id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  createdBy: k.createdBy,
  createdAt: k.createdAt,
  ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
  ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}),
  ...(k.revokedAt ? { revokedAt: k.revokedAt } : {}),
});

/*
 * Claves de API de una empresa, para integraciones (otro sistema que factura, vende o consulta).
 *
 * Una clave es `lbk_<prefijo>_<secreto>`: el prefijo (8 hex) la identifica y el secreto (256 bits al azar) la prueba.
 * Solo se guarda el SHA-256 del secreto: con 256 bits al azar no hace falta un hash lento, y una copia de la base no
 * deja usar ninguna clave. El token completo se muestra una única vez, al crearla.
 *
 * Cada clave lleva sus permisos (`scopes`), un subconjunto de los de quien la crea y nunca los de administración.
 * Se autentica sobre las mismas rutas de la API que la sesión, con `Authorization: Bearer <clave>`; cada ruta sigue
 * exigiendo su permiso. Una clave pertenece a la empresa, no a la persona: sigue valiendo si quien la creó se va, y se
 * revoca desde la lista. Las claves no pueden crear ni administrar claves.
 */
export function createApiKeyService({ client, db, now = () => new Date() }) {
  const keys = db.collection(COLLECTIONS.apiKeys);

  return {
    async create({ tenantId, userId, role }, input, { inTx } = {}) {
      const name = String(input.name ?? '').trim();
      if (!name) fail('falta el nombre de la clave');
      if (name.length > 60) fail('el nombre admite como máximo 60 caracteres');
      const scopes = [...new Set(input.scopes ?? [])];
      if (scopes.length === 0) fail('elige al menos un permiso para la clave');
      for (const scope of scopes) {
        if (!GRANTABLE_SCOPES.includes(scope)) fail(`el permiso ${scope} no se puede dar a una clave de API`);
        if (!can(role, scope)) fail(`no puedes dar a una clave un permiso que no tienes: ${scope}`, 'FORBIDDEN');
      }
      let expiresAt;
      if (input.expiresAt) {
        expiresAt = parseCalendarDay(input.expiresAt, 'la fecha de vencimiento', fail);
        if (expiresAt.getTime() <= now().getTime() - DAY_MS / 2) fail('la fecha de vencimiento ya pasó');
      }
      const active = await keys.countDocuments({ tenantId, revokedAt: { $exists: false } });
      if (active >= MAX_ACTIVE_KEYS) fail(`la empresa ya tiene ${MAX_ACTIVE_KEYS} claves activas: revoca alguna`, 'INVALID_STATE');

      // El prefijo es único en toda la base; si dos coinciden (una en 4 000 millones), se sortea otro.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const prefix = randomBytes(4).toString('hex');
        const secret = randomBytes(32).toString('base64url');
        const doc = { tenantId, name, prefix, secretHash: sha256(secret).toString('hex'), scopes, createdBy: userId, createdAt: now(), ...(expiresAt ? { expiresAt } : {}) };
        try {
          const created = await withTransaction(client, async (session) => {
            const { insertedId } = await keys.insertOne(doc, { session });
            const result = { ...doc, _id: insertedId };
            if (inTx) await inTx(session, view(result));
            return result;
          });
          return { token: `lbk_${prefix}_${secret}`, apiKey: view(created) };
        } catch (err) {
          if (isDuplicate(err, 'apikey_prefix')) continue;
          throw err;
        }
      }
      return fail('no se pudo generar la clave: inténtalo de nuevo', 'INVALID_STATE');
    },

    async list(tenantId) {
      const rows = await keys.find({ tenantId }, { sort: { _id: -1 }, limit: 200 }).toArray();
      return rows.map(view);
    },

    /** Revoca una clave. Repetir no cambia nada. */
    async revoke(tenantId, id, { inTx } = {}) {
      if (!/^[a-f0-9]{24}$/.test(String(id))) fail('clave inválida');
      const key = await keys.findOne({ _id: new ObjectId(id), tenantId });
      if (!key) fail('la clave no existe', 'NOT_FOUND');
      if (key.revokedAt) return view(key);
      return withTransaction(client, async (session) => {
        const updated = await keys.findOneAndUpdate(
          { _id: key._id, tenantId, revokedAt: { $exists: false } },
          { $set: { revokedAt: now() } },
          { session, returnDocument: 'after' },
        );
        const result = view(updated ?? { ...key, revokedAt: now() });
        if (updated && inTx) await inTx(session, result);
        return result;
      });
    },

    /**
     * Autentica una clave para una empresa y un permiso. Toda falla de identidad responde igual (401), sin decir si
     * la clave no existe, venció, se revocó o es de otra empresa; solo un permiso que falta es 403.
     */
    async authenticate(token, tenantId, permission) {
      const match = TOKEN_PATTERN.exec(String(token ?? ''));
      if (!match) INVALID();
      const [, prefix, secret] = match;
      const key = await keys.findOne({ prefix });
      const given = sha256(secret);
      const stored = Buffer.from(key?.secretHash ?? '0'.repeat(64), 'hex');
      const same = stored.length === given.length && timingSafeEqual(stored, given);
      if (!key || !same) INVALID();
      if (key.revokedAt) INVALID();
      if (key.expiresAt && key.expiresAt.getTime() + DAY_MS / 2 <= now().getTime()) INVALID();
      if (String(key.tenantId) !== String(tenantId)) INVALID();
      if (!key.scopes.includes(permission)) fail('la clave de API no tiene permiso para esto', 'FORBIDDEN');
      if (!key.lastUsedAt || now().getTime() - key.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
        // La marca de último uso es informativa: si falla, la petición sigue.
        await keys.updateOne({ _id: key._id }, { $set: { lastUsedAt: now() } }).catch(() => {});
      }
      return { userId: null, tenantId: key.tenantId, role: 'apikey', apiKeyId: key._id };
    },
  };
}
