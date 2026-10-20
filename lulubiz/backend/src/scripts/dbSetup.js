import { COLLECTIONS, ensureIndexes } from '../data/db.js';

const ROLE_ALREADY_EXISTS = 51002;
const USER_ALREADY_EXISTS = 51003;

/**
 * Permisos mínimos de la aplicación, colección por colección. Lo que no está aquí está prohibido.
 *
 *  - `journals` y `audit` solo admiten `find` e `insert`: ni el código ni una vulnerabilidad ni una
 *    credencial filtrada pueden editar o borrar un asiento ni un evento de auditoría. Corregir es
 *    reversar, y eso es insertar.
 *  - Nada se borra salvo lo que de verdad caduca o se retira: sesiones, tokens y membresías.
 *  - La aplicación no puede crear ni borrar colecciones ni índices: eso es de este script.
 */
export function appPrivileges(dbName) {
  const on = (collection, actions) => ({ resource: { db: dbName, collection }, actions });
  const FIND_INSERT_UPDATE = ['find', 'insert', 'update'];
  return [
    on(COLLECTIONS.journals, ['find', 'insert']),
    on(COLLECTIONS.audit, ['find', 'insert']),
    on(COLLECTIONS.balances, FIND_INSERT_UPDATE),
    on(COLLECTIONS.counters, FIND_INSERT_UPDATE),
    on(COLLECTIONS.periods, FIND_INSERT_UPDATE),
    on(COLLECTIONS.settings, FIND_INSERT_UPDATE),
    on(COLLECTIONS.resolutions, FIND_INSERT_UPDATE),
    on(COLLECTIONS.invoices, FIND_INSERT_UPDATE),
    on(COLLECTIONS.creditNotes, FIND_INSERT_UPDATE),
    on(COLLECTIONS.receipts, FIND_INSERT_UPDATE),
    on(COLLECTIONS.purchases, FIND_INSERT_UPDATE),
    on(COLLECTIONS.supplierNotes, FIND_INSERT_UPDATE),
    on(COLLECTIONS.payments, FIND_INSERT_UPDATE),
    on(COLLECTIONS.items, FIND_INSERT_UPDATE),
    on(COLLECTIONS.warehouses, FIND_INSERT_UPDATE),
    on(COLLECTIONS.stock, FIND_INSERT_UPDATE),
    on(COLLECTIONS.movements, ['find', 'insert']),
    on(COLLECTIONS.stockDocs, ['find', 'insert']),
    on(COLLECTIONS.accounts, FIND_INSERT_UPDATE),
    on(COLLECTIONS.parties, FIND_INSERT_UPDATE),
    on(COLLECTIONS.tenants, FIND_INSERT_UPDATE),
    on(COLLECTIONS.users, FIND_INSERT_UPDATE),
    on(COLLECTIONS.memberships, [...FIND_INSERT_UPDATE, 'remove']),
    on(COLLECTIONS.sessions, [...FIND_INSERT_UPDATE, 'remove']),
    on(COLLECTIONS.tokens, [...FIND_INSERT_UPDATE, 'remove']),
  ];
}

/**
 * Prepara la base de datos con credenciales de administración: crea las colecciones, los índices,
 * el rol de la aplicación y su usuario. Se puede repetir: actualiza el rol y rota la contraseña.
 * Las colecciones se crean aquí porque una transacción que las creara implícitamente exigiría
 * a la aplicación el permiso de crear colecciones.
 */
export async function setupDatabase({ adminClient, dbName, appUser, appPassword, roleName = 'lulubiz_app' }) {
  if (!appUser || !appPassword) throw new Error('faltan el usuario y la contraseña de la aplicación');
  if (appPassword.length < 16) throw new Error('la contraseña de la aplicación debe tener al menos 16 caracteres');

  const db = adminClient.db(dbName);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of Object.values(COLLECTIONS)) {
    if (!existing.has(name)) await db.createCollection(name);
  }
  await ensureIndexes(db);

  const admin = adminClient.db('admin');
  const privileges = appPrivileges(dbName);
  let roleCreated = true;
  try {
    await admin.command({ createRole: roleName, privileges, roles: [] });
  } catch (err) {
    if (err?.code !== ROLE_ALREADY_EXISTS) throw err;
    roleCreated = false;
    await admin.command({ updateRole: roleName, privileges, roles: [] });
  }

  const roles = [{ role: roleName, db: 'admin' }];
  let userCreated = true;
  try {
    await admin.command({ createUser: appUser, pwd: appPassword, roles });
  } catch (err) {
    if (err?.code !== USER_ALREADY_EXISTS) throw err;
    userCreated = false;
    await admin.command({ updateUser: appUser, pwd: appPassword, roles });
  }

  return { roleName, roleCreated, userCreated, collections: Object.values(COLLECTIONS) };
}
