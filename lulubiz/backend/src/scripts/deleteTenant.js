import { COLLECTIONS } from '../data/db.js';

export class DeleteTenantError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'DeleteTenantError';
    this.code = code;
  }
}

/** Colecciones con datos de una empresa. `tenants` se borra al final y `users` y `sessions` son identidad global: no se tocan. */
const GLOBAL = new Set(['tenants', 'users', 'sessions']);
const TENANT_COLLECTIONS = Object.values(COLLECTIONS).filter((name) => !GLOBAL.has(name));

/**
 * Borrado definitivo de una empresa y de todo lo suyo. NO lo hace la aplicación (su usuario de base de datos no puede
 * borrar el libro ni la auditoría, a propósito): es un paso de operación con credenciales de administración.
 *
 * Por defecto solo cuenta lo que borraría (`apply: false`). Para borrar hace falta todo esto a la vez:
 *   · `apply: true`;
 *   · `confirmName`: el nombre exacto de la empresa, para no borrar la equivocada;
 *   · `exportDelivered: true`: quien opera confirma que el cliente recibió su exportación (§ Datos de la empresa).
 *
 * El registro de auditoría de la empresa se borra con ella; por eso quien opera debe dejar constancia del borrado en su
 * propio registro (el script imprime una línea con la fecha, el identificador y los totales).
 *
 * Idempotente y reanudable: `tenants` se borra al final, así que si algo falla a la mitad la empresa sigue existiendo y
 * se puede repetir. Las cuentas de usuario no se borran (una persona puede ser miembro de otras empresas); se informa
 * cuáles quedan sin ninguna empresa para que se decida caso por caso.
 */
export async function deleteTenantData(db, tenantId, { apply = false, confirmName, exportDelivered = false } = {}) {
  const tenant = await db.collection(COLLECTIONS.tenants).findOne({ _id: tenantId });
  if (!tenant) throw new DeleteTenantError('la empresa no existe', 'NOT_FOUND');

  const counts = {};
  for (const name of TENANT_COLLECTIONS) counts[name] = await db.collection(name).countDocuments({ tenantId });

  const memberIds = (await db.collection(COLLECTIONS.memberships).find({ tenantId }, { projection: { userId: 1 } }).toArray()).map((m) => m.userId);
  const stillMembers = new Set(
    (await db.collection(COLLECTIONS.memberships).find({ userId: { $in: memberIds }, tenantId: { $ne: tenantId } }, { projection: { userId: 1 } }).toArray()).map((m) => String(m.userId)),
  );
  const orphanUserIds = memberIds.filter((id) => !stillMembers.has(String(id)));
  const orphans = orphanUserIds.length ? await db.collection(COLLECTIONS.users).find({ _id: { $in: orphanUserIds } }, { projection: { email: 1 } }).toArray() : [];
  const summary = { tenantId, name: tenant.name, counts, orphanUsers: orphans.map((u) => u.email).sort() };

  if (!apply) return { ...summary, deleted: false };
  if (confirmName !== tenant.name) throw new DeleteTenantError('el nombre de confirmación no coincide con el de la empresa');
  if (!exportDelivered) throw new DeleteTenantError('confirma que el cliente recibió su exportación antes de borrar', 'EXPORT_NOT_CONFIRMED');

  for (const name of TENANT_COLLECTIONS) await db.collection(name).deleteMany({ tenantId });
  await db.collection(COLLECTIONS.tenants).deleteOne({ _id: tenantId });
  return { ...summary, deleted: true };
}
