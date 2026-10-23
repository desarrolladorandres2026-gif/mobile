import { MongoClient } from 'mongodb';
import { ensureIndexes } from '../data/db.js';
import { buildApp } from '../http/app.js';
import { loadConfig } from '../http/config.js';
import { createMemoryMailer } from '../mail/mailer.js';

/*
 * Crea una empresa y un propietario ya verificados, para probar en desarrollo sin servidor de correo.
 * Uso: npm run dev:user [correo] [contraseña]. Se niega a correr en producción.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('npm run dev:user no corre en producción');
  process.exit(1);
}
const email = process.argv[2] ?? 'admin@lulubiz.test';
const password = process.argv[3] ?? 'correcto-caballo-grapa-2026';

const config = loadConfig();
const client = await MongoClient.connect(config.mongoUri);
const db = client.db(config.dbName);
await ensureIndexes(db);
const app = await buildApp({ client, db, config, mailer: createMemoryMailer(), reporter: { report: async () => true } });
const res = await app.inject({
  method: 'POST',
  url: '/v1/auth/register',
  payload: { companyName: 'Empresa de prueba SAS', country: 'CO', currency: 'COP', ownerName: 'Administrador', email, password },
});
if (res.statusCode !== 201) console.error(`registro: ${res.statusCode} ${res.body}`);
else {
  await db.collection('users').updateOne({ email: email.toLowerCase() }, { $set: { emailVerifiedAt: new Date() } });
  console.log(`Listo. Correo: ${email}  Contraseña: ${password}`);
}
await app.close();
await client.close();
