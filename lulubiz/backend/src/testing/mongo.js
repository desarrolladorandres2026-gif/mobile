import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

/**
 * Réplica en memoria con autenticación activada y un usuario administrador. Sirve para probar
 * los permisos reales de la base de datos: `connectAs` abre un cliente con las credenciales dadas.
 */
export async function startMongoWithAuth() {
  const rootUser = 'root';
  const rootPassword = 'clave-root-de-prueba-1234';
  // `auth` va dentro de `replSet`: al nivel superior se ignora y la base arranca sin autenticación.
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, auth: { enable: true, customRootName: rootUser, customRootPwd: rootPassword } },
  });
  const uri = replSet.getUri();
  const connectAs = (username, password, authSource = 'admin') =>
    MongoClient.connect(uri, { auth: { username, password }, authSource });
  const rootClient = await connectAs(rootUser, rootPassword);
  return {
    rootClient,
    connectAs,
    async stop() {
      await rootClient.close();
      await replSet.stop();
    },
  };
}

/** Réplica en memoria: las transacciones de MongoDB exigen un conjunto de réplicas. */
export async function startMongo(dbName = 'lulubiz_test') {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = await MongoClient.connect(replSet.getUri());
  return {
    client,
    db: client.db(dbName),
    async stop() {
      await client.close();
      await replSet.stop();
    },
  };
}
