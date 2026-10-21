import { MongoClient, ObjectId } from 'mongodb';
import { verifyIntegrity } from './verifyIntegrity.js';

/**
 * Verifica la integridad de la base (solo lee). Sirve tras restaurar una copia de seguridad y como vigilancia.
 *   MONGODB_URI   conexión (la de la aplicación basta: solo hace consultas)
 *   MONGODB_DB    base de datos (por defecto lulubiz)
 *   TENANT_ID     opcional: una sola empresa
 * Sale con código 1 si algo no cuadra.
 */
const { MONGODB_URI = 'mongodb://127.0.0.1:27017/lulubiz', MONGODB_DB = 'lulubiz', TENANT_ID } = process.env;

const client = await MongoClient.connect(MONGODB_URI);
let ok = false;
try {
  const result = await verifyIntegrity(client.db(MONGODB_DB), TENANT_ID ? { tenantId: new ObjectId(TENANT_ID) } : {});
  ok = result.ok;
  for (const tenant of result.tenants) {
    console.log(`\n${tenant.ok ? 'EN ORDEN' : 'CON DIFERENCIAS'}  ${tenant.name} (${tenant.tenantId})`);
    for (const check of tenant.checks) console.log(`  ${check.ok ? 'ok ' : 'MAL'}  ${check.name}\n        ${check.detail}`);
  }
  console.log(`\n${result.tenants.length} empresas revisadas: ${ok ? 'todo en orden.' : 'HAY DIFERENCIAS, no las corrijas a mano: investígalas.'}`);
} finally {
  await client.close();
}
process.exit(ok ? 0 : 1);
