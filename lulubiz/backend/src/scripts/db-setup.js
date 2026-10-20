import { MongoClient } from 'mongodb';
import { setupDatabase } from './dbSetup.js';

/**
 * Paso de despliegue: se corre con credenciales de administración, no con las de la aplicación.
 *   MONGODB_ADMIN_URI   conexión de un usuario administrador (obligatoria)
 *   MONGODB_DB          base de datos (por defecto lulubiz)
 *   APP_DB_USER         usuario de la aplicación (por defecto lulubiz_app)
 *   APP_DB_PASSWORD     contraseña del usuario de la aplicación, de 16 caracteres o más (obligatoria)
 */
const { MONGODB_ADMIN_URI, MONGODB_DB = 'lulubiz', APP_DB_USER = 'lulubiz_app', APP_DB_PASSWORD } = process.env;

if (!MONGODB_ADMIN_URI || !APP_DB_PASSWORD) {
  console.error('Faltan MONGODB_ADMIN_URI y APP_DB_PASSWORD.');
  process.exit(1);
}

const client = await MongoClient.connect(MONGODB_ADMIN_URI);
try {
  const result = await setupDatabase({ adminClient: client, dbName: MONGODB_DB, appUser: APP_DB_USER, appPassword: APP_DB_PASSWORD });
  console.log(
    `Base ${MONGODB_DB} lista. Rol ${result.roleName}: ${result.roleCreated ? 'creado' : 'actualizado'}. ` +
      `Usuario ${APP_DB_USER}: ${result.userCreated ? 'creado' : 'contraseña rotada'}.`,
  );
} finally {
  await client.close();
}
