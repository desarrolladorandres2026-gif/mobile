import { MongoClient } from 'mongodb';
import { ensureIndexes } from './data/db.js';
import { buildApp } from './http/app.js';
import { loadConfig } from './http/config.js';
import { installProcessHandlers } from './observability/errorReporter.js';

const config = loadConfig();
const client = await MongoClient.connect(config.mongoUri);
const db = client.db(config.dbName);

// En producción la aplicación no tiene permiso para crear índices ni colecciones: los crea
// `npm run db:setup` con credenciales de administración, como paso de despliegue.
if (config.ensureIndexesOnStart) await ensureIndexes(db);

const app = await buildApp({ client, db, config, logger: true });
installProcessHandlers({ reporter: app.reporter, log: app.log });

async function shutdown(signal) {
  app.log.info({ signal }, 'cerrando');
  await app.close();
  await client.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
