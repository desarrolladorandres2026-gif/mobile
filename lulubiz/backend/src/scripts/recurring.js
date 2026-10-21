import { MongoClient, ObjectId } from 'mongodb';
import { buildApp } from '../http/app.js';
import { loadConfig } from '../http/config.js';
import { COLLECTIONS } from '../data/db.js';

/**
 * Genera las facturas recurrentes vencidas de todas las empresas. Pensado para una tarea programada (cron) diaria;
 * la misma generación está en la interfaz («Generar las vencidas»). Es seguro repetirla: cada período lleva una clave de
 * idempotencia propia. Sale con código 1 si alguna plantilla falló.
 *   TENANT_ID   opcional: una sola empresa
 * Las facturas quedan a nombre de nadie (sin usuario) y la generación no deja evento de auditoría de sesión.
 */
const config = loadConfig();
const client = await MongoClient.connect(config.mongoUri);
const db = client.db(config.dbName);
const app = await buildApp({ client, db, config });
let failures = 0;
try {
  const filter = process.env.TENANT_ID ? { _id: new ObjectId(process.env.TENANT_ID) } : {};
  const tenants = await db.collection(COLLECTIONS.tenants).find(filter, { projection: { name: 1 } }).toArray();
  for (const tenant of tenants) {
    const { generated, failed } = await app.commercial.runRecurring(tenant._id, {}, { userId: null });
    failures += failed.length;
    if (generated.length || failed.length) console.log(`${tenant.name}: ${generated.length} emitidas, ${failed.length} con error`);
    for (const g of generated) console.log(`  ok   ${g.name} ${g.date} → ${g.number ?? g.invoiceId}${g.pending ? ' (pendiente del proveedor)' : ''}`);
    for (const f of failed) console.log(`  MAL  ${f.name} ${f.date}: ${f.message}`);
  }
  console.log(`${tenants.length} empresas revisadas.`);
} finally {
  await app.close();
  await client.close();
}
process.exit(failures ? 1 : 0);
